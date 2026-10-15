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

export type OndcDomain = "ONDC:RET11" | "ONDC:TRV10";

export type ContextInput = {
  domain: OndcDomain;
  action: string;
  /** STD code form, e.g. "std:080" for Bengaluru. */
  city: string;
  transactionId: string;
  messageId?: string;
  bppId?: string;
  bppUri?: string;
  now?: Date;
  ttl?: string;
};

export function buildContext(c: ContextInput): Record<string, unknown> {
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
  if (c.domain === "ONDC:TRV10") {
    return {
      ...base,
      version: "2.0.1",
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
