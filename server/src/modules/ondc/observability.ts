import { env } from "../../config/env.js";
import { prisma } from "../../lib/prisma.js";

// ONDC Network Observability: every transaction message, both ways, with its
// ACK or NACK, pushed to ONDC's logging service.
//
// ONDC requires this before going live (task "Submit network observability
// logs"), from on_search onwards and for complaints, and requires it to be
// automatic. The schema is ONDC's "Schema for Pushing Logs on Network
// Observability API": each log is { type, data }, where type is the action
// for a message and "<action>_response" for the ACK or NACK it got, and data
// is the message, or for a response its context and ack. A call that failed
// at the HTTP level is logged as the request with a TECH-ERROR carrying the
// status code.
//
// Personal data never leaves: names, phones, emails, addresses and exact
// locations are replaced with "****" before a log is even stored. City and
// PIN code are kept, as ONDC asks.
//
// Logs go into an outbox and a background loop pushes them, so ONDC's service
// being slow or down never delays an order or a reply to a seller.

export const NO_URL = {
  preprod: "https://analytics-api-pre-prod.aws.ondc.org/v1/api/push-txn-logs",
  prod: "https://analytics-api.aws.ondc.org/v1/api/push-txn-logs",
} as const;

/** The token for the business profile a message belongs to, or null if none is set. */
export function tokenFor(domain: unknown, tokens = { retail: env.ONDC_NO_TOKEN_RETAIL, ride: env.ONDC_NO_TOKEN_RIDE }): string | null {
  if (typeof domain !== "string") return null;
  if (domain.startsWith("ONDC:RET") || domain.startsWith("nic2004:")) return tokens.retail || null;
  if (domain.startsWith("ONDC:TRV")) return tokens.ride || null;
  return null;
}

const MASK = "****";
/** Objects whose contents describe a person: everything in them is masked except these. */
const PERSONAL_SCOPES = new Set(["billing", "end", "customer", "person", "contact", "stops"]);
const KEEP = new Set(["city", "area_code", "state", "country", "code", "type", "id"]);
/** Masked wherever they appear. */
const ALWAYS = new Set(["phone", "email", "gps"]);

/**
 * A copy with personal data replaced. Strings inside a personal scope are
 * masked unless they are a location's city, PIN code, state or country, or a
 * code or id; phones, emails and coordinates are masked anywhere.
 */
export function anonymise(value: unknown, inPersonal = false, key = ""): unknown {
  if (Array.isArray(value)) return value.map((v) => anonymise(v, inPersonal, key));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = anonymise(v, inPersonal || PERSONAL_SCOPES.has(k), k);
    }
    return out;
  }
  if (typeof value !== "string" || value === "") return value;
  if (ALWAYS.has(key)) return MASK;
  if (inPersonal && !KEEP.has(key)) return MASK;
  return value;
}

/**
 * Queues one log. Never throws and never waits on ONDC: observability must
 * not be able to break the transaction it describes. Nothing is queued for a
 * profile with no token set.
 */
export function recordNo(type: string, data: { context?: Record<string, unknown> } & Record<string, unknown>): void {
  const domain = data.context?.domain;
  if (!tokenFor(domain)) return;
  void prisma.ondcNoLog
    .create({ data: { domain: String(domain), type, payload: JSON.stringify({ type, data: anonymise(data) }) } })
    .catch((err: unknown) => console.error("[ondc-no] could not queue", type, err instanceof Error ? err.message : String(err)));
}

/** The response half: what we, or the seller, answered a message with. */
export function responseLog(
  context: Record<string, unknown> | undefined,
  ack: "ACK" | "NACK",
  error?: { type?: unknown; code?: unknown; message?: unknown } | null,
) {
  return {
    context: context ?? {},
    message: { ack: { status: ack } },
    ...(error && error.code !== undefined ? { error: { type: String(error.type ?? "CORE-ERROR"), code: String(error.code), message: String(error.message ?? "") } } : {}),
  };
}

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{
  status: number;
  text(): Promise<string>;
}>;

/** Gives up on a log after this many failed pushes; ONDC refusing its shape will not change on retry. */
const MAX_ATTEMPTS = 8;

/**
 * Pushes queued logs, oldest first. A log ONDC accepts (HTTP 200, including
 * the 2001 extra-field warning) is marked sent; a refusal is kept with its
 * reason and retried up to a limit.
 */
export async function pushPending(opts: { fetch?: Fetch; url?: string; limit?: number } = {}) {
  const doFetch: Fetch = opts.fetch ?? ((u, i) => fetch(u, i));
  const url = opts.url ?? NO_URL[env.ONDC_REGISTRY_ENV];
  const due = await prisma.ondcNoLog.findMany({
    where: { sentAt: null, attempts: { lt: MAX_ATTEMPTS } },
    orderBy: { createdAt: "asc" },
    take: opts.limit ?? 100,
  });
  let sent = 0;
  for (const log of due) {
    const token = tokenFor(log.domain);
    if (!token) continue;
    let error: string | null = null;
    try {
      const res = await doFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: log.payload,
        signal: AbortSignal.timeout(10_000),
      });
      const text = (await res.text()).slice(0, 500);
      if (res.status !== 200) error = `HTTP ${res.status}: ${text}`;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    await prisma.ondcNoLog.update({
      where: { id: log.id },
      data: error ? { attempts: { increment: 1 }, lastError: error.slice(0, 500) } : { sentAt: new Date(), lastError: null },
    });
    if (!error) sent++;
  }
  return { tried: due.length, sent };
}

/** Sent logs are kept a week for reference, then dropped. */
export async function pruneNoLogs(now = new Date(), days = 7) {
  const cutoff = new Date(now.getTime() - days * 86_400_000);
  return prisma.ondcNoLog.deleteMany({ where: { createdAt: { lt: cutoff }, OR: [{ sentAt: { not: null } }, { attempts: { gte: MAX_ATTEMPTS } }] } });
}
