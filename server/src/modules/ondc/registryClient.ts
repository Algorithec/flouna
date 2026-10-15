import { createAuthorizationHeader, type SigningIdentity } from "./signing.js";

// Looks up other network participants in the ONDC registry.
//
// Its job is to answer one question safely: what public key does this
// subscriber sign with, under this key id, right now? Everything we receive
// from a seller app is verified against that answer, so the rules here are
// strict. A participant that is not SUBSCRIBED, or whose key is outside its
// validity window, has no key as far as we are concerned.
//
// Field names are the ones the pre-production registry actually returned to a
// signed /v2.0/lookup on 2026-10-16, not the ones in the docs, which omit them.

export const REGISTRY_URL = {
  preprod: "https://preprod.registry.ondc.org/v2.0/lookup",
  prod: "https://prod.registry.ondc.org/v2.0/lookup",
} as const;

export type Participant = {
  subscriber_id: string;
  ukId: string;
  status: string;
  type: string;
  domain: string;
  subscriber_url: string;
  signing_public_key: string;
  encr_public_key: string;
  valid_from: string;
  valid_until: string;
};

type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

/** How long a looked-up key is trusted before asking again. */
const CACHE_MS = 10 * 60_000;
/**
 * How long "the registry has no such key" is remembered. Short, so a seller
 * that has just subscribed is not refused for ten minutes, and long enough
 * that a burst of messages under a bad key id asks the registry once.
 */
const MISS_CACHE_MS = 60_000;
/** The registry answers in well under a second; a hung lookup must not hold a seller's request open. */
const LOOKUP_TIMEOUT_MS = 5_000;
/**
 * Lookups are keyed by whatever key id an incoming request names, before
 * anything about it is verified, so the cache is bounded or anyone could grow
 * it without limit by inventing ids.
 */
const MAX_CACHE_ENTRIES = 5_000;

export function createRegistryClient(opts: {
  registryUrl: string;
  identity: SigningIdentity;
  fetch?: FetchLike;
  now?: () => number;
  timeoutMs?: number;
  maxCacheEntries?: number;
}) {
  const doFetch: FetchLike = opts.fetch ?? ((url, init) => fetch(url, init));
  const now = opts.now ?? (() => Date.now());
  const timeoutMs = opts.timeoutMs ?? LOOKUP_TIMEOUT_MS;
  const maxEntries = opts.maxCacheEntries ?? MAX_CACHE_ENTRIES;
  // Map keeps insertion order, so the first key is the oldest.
  // Every entry for the key id is kept: the registry lists a participant once
  // per domain, and only one of those may be SUBSCRIBED.
  const cache = new Map<string, { at: number; value: Participant[] }>();

  async function lookup(body: Record<string, string>): Promise<Participant[]> {
    const raw = JSON.stringify(body);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await doFetch(opts.registryUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: createAuthorizationHeader(raw, opts.identity) },
        body: raw,
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`Registry lookup failed with HTTP ${res.status}`);
      const data = await res.json();
      return Array.isArray(data) ? (data as Participant[]) : [];
    } finally {
      clearTimeout(timer);
    }
  }

  // Lookups in flight, so a burst of messages from a seller we have not seen
  // yet asks the registry once rather than once per message.
  const inFlight = new Map<string, Promise<Participant[] | null>>();

  /** The participant's signing key for this key id, if it is usable now. */
  async function publicKeyFor(subscriberId: string, uniqueKeyId: string): Promise<string | null> {
    const key = `${subscriberId}|${uniqueKeyId}`;
    const hit = cache.get(key);
    if (hit && now() - hit.at < (hit.value.length ? CACHE_MS : MISS_CACHE_MS)) return firstUsable(hit.value, now());

    let pending = inFlight.get(key);
    if (!pending) {
      pending = lookup({ subscriber_id: subscriberId, ukId: uniqueKeyId })
        .then((list) => {
          const matches = list.filter((p) => p.subscriber_id === subscriberId && p.ukId === uniqueKeyId);
          cache.delete(key);
          cache.set(key, { at: now(), value: matches });
          while (cache.size > maxEntries) cache.delete(cache.keys().next().value!);
          return matches;
        })
        // An unreachable registry is not a reason to trust a stale or unknown
        // key. Fail closed and do not cache the failure, so the next message
        // asks again.
        .catch(() => null)
        .finally(() => inFlight.delete(key));
      inFlight.set(key, pending);
    }
    const matches = await pending;
    return matches ? firstUsable(matches, now()) : null;
  }

  return { lookup, publicKeyFor, cacheSize: () => cache.size };
}

function firstUsable(list: Participant[], nowMs: number): string | null {
  for (const p of list) {
    const k = usableKey(p, nowMs);
    if (k) return k;
  }
  return null;
}

function usableKey(p: Participant | null, nowMs: number): string | null {
  if (!p || p.status !== "SUBSCRIBED" || !p.signing_public_key) return null;
  const from = Date.parse(p.valid_from);
  const until = Date.parse(p.valid_until);
  if (Number.isFinite(from) && nowMs < from) return null;
  if (Number.isFinite(until) && nowMs > until) return null;
  return p.signing_public_key;
}
