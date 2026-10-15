import { Router, type Request } from "express";
import { BAP_ID } from "./context.js";
import { digestOf, verifyAuthorizationHeader } from "./signing.js";

// Where seller apps answer us.
//
// Every request we send is acknowledged at once and answered later, by the
// seller app calling one of these endpoints on ondc.flouna.com. Nothing here is
// trusted until its signature verifies against the sender's key in the ONDC
// registry: a forged on_confirm would otherwise be able to tell a customer
// their order was placed, or quote a price nobody offered.
//
// Messages that arrive through the gateway carry a second signature, the
// gateway's, in X-Gateway-Authorization. When it is present it is verified as
// well, so a relayed message is only accepted if both hops are genuine.

export const CALLBACK_ACTIONS = [
  "on_search",
  "on_select",
  "on_init",
  "on_confirm",
  "on_status",
  "on_track",
  "on_cancel",
  "on_update",
  "on_rating",
  "on_support",
] as const;

export type ReceivedCallback = {
  action: string;
  body: Record<string, unknown>;
  raw: string;
  senderId: string;
};

export type CallbackDeps = {
  /** Registered signing key for a subscriber and key id, or null. */
  publicKeyFor: (subscriberId: string, uniqueKeyId: string) => Promise<string | null>;
  /**
   * Persists a verified message. If it throws, the message is refused with a
   * NACK so the seller app sends it again: an order confirmation we
   * acknowledged but never stored would be lost for good.
   */
  record: (cb: ReceivedCallback) => Promise<void>;
};

/**
 * How long a delivered message is remembered, so a resend of the same bytes is
 * acknowledged without being stored twice. Longer than a signature can live
 * (an hour, plus clock allowance), so a replay can never outlast the memory.
 */
const SEEN_MS = 2 * 60 * 60_000;
const SEEN_MAX = 20_000;

const ACK = { message: { ack: { status: "ACK" } } };

function nack(type: string, code: string, message: string) {
  return { message: { ack: { status: "NACK" } }, error: { type, code, message } };
}

export function createCallbacksRouter(deps: CallbackDeps | null, opts: { bapId?: string } = {}) {
  const router = Router();
  // Messages addressed to any other buyer app are refused.
  const bapId = opts.bapId ?? BAP_ID;
  // Digest of each stored message, by sender, with when it arrived. Map keeps
  // insertion order, so the oldest entry is the first one.
  const seen = new Map<string, number>();

  function remembered(key: string, nowMs: number): boolean {
    const at = seen.get(key);
    return at !== undefined && nowMs - at < SEEN_MS;
  }
  function remember(key: string, nowMs: number) {
    seen.set(key, nowMs);
    while (seen.size > SEEN_MAX) seen.delete(seen.keys().next().value!);
  }

  router.post("/ondc/:action", async (req: Request, res, next) => {
    const action = req.params.action ?? "";
    // on_subscribe belongs to the registry handshake, handled before this.
    if (!(CALLBACK_ACTIONS as readonly string[]).includes(action)) return next();

    if (!deps) {
      res.status(503).json(nack("CORE-ERROR", "10001", "ONDC is not configured on this deployment"));
      return;
    }

    // The signature covers the bytes as sent. Decoding them to a string and
    // back would alter anything that is not valid UTF-8, and a genuine
    // message would then fail to verify.
    const rawBytes = (req as Request & { rawBody?: Buffer }).rawBody;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const ctx = (body.context ?? {}) as Record<string, unknown>;
    if (!rawBytes?.length || ctx.action !== action) {
      res.status(400).json(nack("CONTEXT-ERROR", "10002", "Context action does not match the endpoint"));
      return;
    }
    if (ctx.bap_id !== bapId) {
      res.status(400).json(nack("CONTEXT-ERROR", "10002", "Message is not addressed to this buyer app"));
      return;
    }

    try {
      const sender = await verifyAuthorizationHeader(req.get("authorization"), rawBytes, deps.publicKeyFor);
      if (!sender.ok) {
        res.status(401).json(nack("POLICY-ERROR", "10003", `Signature not accepted: ${sender.reason}`));
        return;
      }
      // A valid signature only proves who sent the message. Without this, any
      // registered participant could sign an on_confirm naming another seller
      // in its context and have it taken as that seller's.
      if (ctx.bpp_id !== sender.subscriberId) {
        res.status(401).json(nack("POLICY-ERROR", "10003", "Signer is not the seller app named in the message"));
        return;
      }
      const gatewayHeader = req.get("x-gateway-authorization");
      if (gatewayHeader) {
        const gw = await verifyAuthorizationHeader(gatewayHeader, rawBytes, deps.publicKeyFor);
        if (!gw.ok) {
          res.status(401).json(nack("POLICY-ERROR", "10003", `Gateway signature not accepted: ${gw.reason}`));
          return;
        }
      }

      const nowMs = Date.now();
      const key = `${sender.subscriberId}|${digestOf(rawBytes)}`;
      if (remembered(key, nowMs)) {
        // A resend of something already stored. Acknowledge it, since the
        // seller evidently did not see our first ACK, and store nothing.
        res.json(ACK);
        return;
      }

      // Stored before the ACK, so an ACK always means we have it.
      await deps.record({ action, body, raw: rawBytes.toString("utf8"), senderId: sender.subscriberId });
      remember(key, nowMs);
      res.json(ACK);
    } catch (err) {
      // A registry key that is not a key, a lookup that throws, a database
      // that is down: refuse the message so the seller app retries it, rather
      // than leave the request open until the seller gives up.
      console.error("[ondc] could not take", action, err instanceof Error ? err.message : String(err));
      if (!res.headersSent) res.status(500).json(nack("CORE-ERROR", "10000", "Could not process the message, retry"));
    }
  });

  return router;
}
