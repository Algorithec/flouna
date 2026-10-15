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

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

/** How long a looked-up key is trusted before asking again. */
const CACHE_MS = 10 * 60_000;

export function createRegistryClient(opts: {
  registryUrl: string;
  identity: SigningIdentity;
  fetch?: FetchLike;
  now?: () => number;
}) {
  const doFetch: FetchLike = opts.fetch ?? ((url, init) => fetch(url, init));
  const now = opts.now ?? (() => Date.now());
  const cache = new Map<string, { at: number; value: Participant | null }>();

  async function lookup(body: Record<string, string>): Promise<Participant[]> {
    const raw = JSON.stringify(body);
    const res = await doFetch(opts.registryUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: createAuthorizationHeader(raw, opts.identity) },
      body: raw,
    });
    if (!res.ok) throw new Error(`Registry lookup failed with HTTP ${res.status}`);
    const data = await res.json();
    return Array.isArray(data) ? (data as Participant[]) : [];
  }

  /** The participant's signing key for this key id, if it is usable now. */
  async function publicKeyFor(subscriberId: string, uniqueKeyId: string): Promise<string | null> {
    const key = `${subscriberId}|${uniqueKeyId}`;
    const hit = cache.get(key);
    if (hit && now() - hit.at < CACHE_MS) return usableKey(hit.value, now());

    let found: Participant | null;
    try {
      const list = await lookup({ subscriber_id: subscriberId, ukId: uniqueKeyId });
      found = list.find((p) => p.subscriber_id === subscriberId && p.ukId === uniqueKeyId) ?? null;
    } catch {
      // An unreachable registry is not a reason to trust a stale or unknown
      // key. Fail closed and do not cache the failure, so the next message
      // asks again.
      return null;
    }
    cache.set(key, { at: now(), value: found });
    return usableKey(found, now());
  }

  return { lookup, publicKeyFor };
}

function usableKey(p: Participant | null, nowMs: number): string | null {
  if (!p || p.status !== "SUBSCRIBED" || !p.signing_public_key) return null;
  const from = Date.parse(p.valid_from);
  const until = Date.parse(p.valid_until);
  if (Number.isFinite(from) && nowMs < from) return null;
  if (Number.isFinite(until) && nowMs > until) return null;
  return p.signing_public_key;
}
