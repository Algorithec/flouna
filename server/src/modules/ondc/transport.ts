import { createAuthorizationHeader, type SigningIdentity } from "./signing.js";

// Sends a signed message to a seller app or the gateway and reads the
// synchronous acknowledgement. ONDC is asynchronous: the ACK only means the
// message was accepted for processing, and the real answer arrives later as a
// callback (on_search, on_select, ...) on our own endpoints.

export const GATEWAY_URL = {
  preprod: "https://preprod.gateway.ondc.org",
  prod: "https://prod.gateway.ondc.org",
} as const;

export type SendResult =
  | { ack: true; status: number }
  | { ack: false; status: number; error?: unknown };

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{
  status: number;
  text(): Promise<string>;
}>;

const TIMEOUT_MS = 10_000;

/**
 * POSTs the envelope to `${baseUrl}/${action}`, signed. Never throws: a
 * network failure is a NACK with status 0, so callers can record it like any
 * other refusal.
 */
export async function sendSigned(
  baseUrl: string,
  action: string,
  envelope: { context: Record<string, unknown>; message: unknown },
  identity: SigningIdentity,
  doFetch: FetchLike = (u, i) => fetch(u, i),
): Promise<SendResult> {
  const body = JSON.stringify(envelope);
  const url = `${baseUrl.replace(/\/+$/, "")}/${action}`;
  try {
    const res = await doFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: createAuthorizationHeader(body, identity) },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    let parsed: { message?: { ack?: { status?: string } }; error?: unknown } = {};
    try {
      const json: unknown = JSON.parse(await res.text());
      // "null" or a bare number is valid JSON but not an acknowledgement, and
      // reading fields off it would throw and be misreported as a network failure.
      if (json && typeof json === "object") parsed = json as typeof parsed;
    } catch {
      // A body that is not JSON is not an acknowledgement.
    }
    const acked = res.status >= 200 && res.status < 300 && parsed.message?.ack?.status === "ACK";
    return acked ? { ack: true, status: res.status } : { ack: false, status: res.status, error: parsed.error };
  } catch (err) {
    return { ack: false, status: 0, error: err instanceof Error ? err.message : String(err) };
  }
}
