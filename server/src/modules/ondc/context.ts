import crypto from "node:crypto";

// The context block every ONDC message carries.
//
// Retail (food) speaks Beckn core 1.2.0 and Mobility (rides) speaks 2.0.1, and
// the two lay the same facts out differently: country and city are flat
// strings in 1.2.0 and nested objects in 2.0.1, and the version field is named
// differently. A seller app on one protocol refuses the other's shape, so the
// domain decides which one is built.

export const BAP_ID = "ondc.flouna.com";
export const BAP_URI = "https://ondc.flouna.com/ondc";

// ONDC:NTS10 is settlement and reconciliation (RSF 2.0.0), which is not tied
// to a city and speaks the 2.0.x layout.
export type OndcDomain = "ONDC:RET11" | "ONDC:TRV10" | "ONDC:NTS10";

export type ContextInput = {
  domain: OndcDomain;
  action: string;
  /** STD code form, e.g. "std:080" for Bengaluru; "*" for settlement (NTS10). */
  city: string;
  transactionId: string;
  messageId?: string;
  bppId?: string;
  bppUri?: string;
  now?: Date;
  ttl?: string;
};

export function buildContext(c: ContextInput): Record<string, unknown> {
  if (c.domain === "ONDC:NTS10" ? c.city !== "*" : !/^std:\d{2,5}$/.test(c.city)) {
    throw new Error(`ONDC city must be an STD code such as std:080 (or "*" for settlement), got ${c.city}`);
  }
  const base = {
    domain: c.domain,
    action: c.action,
    bap_id: BAP_ID,
    bap_uri: BAP_URI,
    ...(c.bppId ? { bpp_id: c.bppId } : {}),
    ...(c.bppUri ? { bpp_uri: c.bppUri } : {}),
    transaction_id: c.transactionId,
    message_id: c.messageId ?? crypto.randomUUID(),
    timestamp: (c.now ?? new Date()).toISOString(),
    ttl: c.ttl ?? "PT30S",
  };
  if (c.domain === "ONDC:TRV10" || c.domain === "ONDC:NTS10") {
    return {
      ...base,
      version: c.domain === "ONDC:NTS10" ? "2.0.0" : "2.0.1",
      location: { country: { code: "IND" }, city: { code: c.city } },
    };
  }
  return { ...base, country: "IND", city: c.city, core_version: "1.2.0" };
}

/**
 * A finder fee percentage, checked. It goes on the wire as what the seller
 * owes us, so a value that is not a real percentage must stop the message
 * rather than be sent as "NaN" or rounded into a different fee.
 */
export function checkedFeePercent(percent: number): number {
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
    throw new Error(`Finder fee must be a percentage from 0 to 100, got ${percent}`);
  }
  if (!hasAtMostDecimals(percent, 2)) {
    throw new Error(`Finder fee is limited to two decimal places, got ${percent}`);
  }
  return percent;
}

/** True when `n` has no more than `places` decimals, allowing for binary float error (0.07 * 100 is not 7). */
export function hasAtMostDecimals(n: number, places: number): boolean {
  const scaled = n * 10 ** places;
  return Math.abs(scaled - Math.round(scaled)) < 1e-6;
}

// Checks on values that go on the wire. A seller app that receives a malformed
// one either refuses the message, with an error that rarely says which field,
// or worse, accepts it and delivers somewhere else. Stopping here names it.

/** "lat,lng" in decimal degrees, as ONDC writes every location. */
export function checkedGps(gps: string): string {
  const m = /^\s*(-?\d{1,3}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$/.exec(gps);
  if (!m || Math.abs(Number(m[1])) > 90 || Math.abs(Number(m[2])) > 180) {
    throw new Error(`ONDC gps must be "lat,lng" in degrees, got ${gps}`);
  }
  return gps;
}

/** An Indian PIN code. */
export function checkedAreaCode(code: string): string {
  if (!/^[1-9]\d{5}$/.test(code)) throw new Error(`ONDC area code must be a 6 digit PIN, got ${code}`);
  return code;
}

/** A public https address, for anything a seller app is told to fetch. */
export function checkedHttpsUrl(url: string, what: string): string {
  let ok = false;
  try {
    ok = new URL(url).protocol === "https:";
  } catch {
    ok = false;
  }
  if (!ok) throw new Error(`${what} must be an https URL, got ${url}`);
  return url;
}

/**
 * Why a configured subscriber id cannot be used, or null if it can.
 *
 * Outgoing messages name BAP_ID as the buyer app, and incoming ones are
 * refused unless they are addressed to the configured id. If the two differ,
 * every seller's answer is refused while our own requests look fine.
 */
export function subscriberIdProblem(configured: string | undefined): string | null {
  if (!configured || configured === BAP_ID) return null;
  return (
    `ONDC_SUBSCRIBER_ID is ${configured} but outgoing ONDC messages name ${BAP_ID} as the buyer app, ` +
    "so every seller's answer would be refused as addressed to someone else"
  );
}

/**
 * Why a workbench address cannot be used, or null when it can. Only ONDC's own
 * hosts, over https: the address receives our signed searches with the
 * customer's location in them.
 */
export function workbenchUrlProblem(url: string | undefined): string | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "ONDC_WORKBENCH_URL is not a URL";
  }
  const host = parsed.hostname.toLowerCase();
  const ondcHost = host === "ondc.tech" || host.endsWith(".ondc.tech") || host === "ondc.org" || host.endsWith(".ondc.org");
  if (parsed.protocol !== "https:" || !ondcHost) {
    return "ONDC_WORKBENCH_URL must be an https address on ondc.tech or ondc.org, such as https://workbench.ondc.tech/api-service";
  }
  if (parsed.search || parsed.hash || parsed.username || parsed.password) {
    return "ONDC_WORKBENCH_URL must be a plain base address, without a query, fragment or credentials";
  }
  return null;
}
