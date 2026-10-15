// The refusals a buyer app sends back, with ONDC's codes for them.
//
// From ONDC's published list (developer-docs, protocol-network-extension/
// error-codes.md, ONDC-RFC-001). Codes there are allotted by role: 1000x are
// the gateway's, 2xxxx the buyer app's, 3xxxx and up the seller's. We answer
// as a buyer app, so only 2xxxx codes are ours to send.

export type OndcErrorType = "CONTEXT-ERROR" | "CORE-ERROR" | "DOMAIN-ERROR" | "POLICY-ERROR" | "JSON-SCHEMA-ERROR";

export const BUYER_ERRORS = {
  /** "Invalid Signature: cannot verify signature for response." */
  INVALID_SIGNATURE: { code: "20001", type: "POLICY-ERROR" },
  /** "Stale Request: cannot process stale request." */
  STALE_REQUEST: { code: "20002", type: "CONTEXT-ERROR" },
  /** "Invalid response: does not meet API contract specifications." */
  INVALID_RESPONSE: { code: "20006", type: "CONTEXT-ERROR" },
  /** "Internal Error: cannot process response due to internal error, please retry." */
  INTERNAL_ERROR: { code: "23001", type: "CORE-ERROR" },
} as const satisfies Record<string, { code: string; type: OndcErrorType }>;

export type BuyerError = (typeof BUYER_ERRORS)[keyof typeof BUYER_ERRORS];

export function nack(err: BuyerError, message: string) {
  return { message: { ack: { status: "NACK" as const } }, error: { type: err.type, code: err.code, message } };
}
