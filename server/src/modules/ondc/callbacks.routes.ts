import { Router, type Request } from "express";
import { verifyAuthorizationHeader } from "./signing.js";

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
  /** Persists a verified message. Failures here must not turn into a NACK. */
  record: (cb: ReceivedCallback) => Promise<void>;
};

const ACK = { message: { ack: { status: "ACK" } } };

function nack(code: string, message: string) {
  return { message: { ack: { status: "NACK" } }, error: { type: "CONTEXT-ERROR", code, message } };
}

export function createCallbacksRouter(deps: CallbackDeps | null) {
  const router = Router();

  router.post("/ondc/:action", async (req: Request, res, next) => {
    const action = req.params.action ?? "";
    // on_subscribe belongs to the registry handshake, handled before this.
    if (!(CALLBACK_ACTIONS as readonly string[]).includes(action)) return next();

    if (!deps) {
      res.status(503).json(nack("10001", "ONDC is not configured on this deployment"));
      return;
    }

    const raw = (req as Request & { rawBody?: Buffer }).rawBody?.toString("utf8") ?? "";
    const body = (req.body ?? {}) as Record<string, unknown>;
    const ctx = (body.context ?? {}) as Record<string, unknown>;
    if (!raw || ctx.action !== action) {
      res.status(400).json(nack("10002", "Context action does not match the endpoint"));
      return;
    }

    const sender = await verifyAuthorizationHeader(req.get("authorization"), raw, deps.publicKeyFor);
    if (!sender.ok) {
      res.status(401).json(nack("10003", `Signature not accepted: ${sender.reason}`));
      return;
    }
    const gatewayHeader = req.get("x-gateway-authorization");
    if (gatewayHeader) {
      const gw = await verifyAuthorizationHeader(gatewayHeader, raw, deps.publicKeyFor);
      if (!gw.ok) {
        res.status(401).json(nack("10003", `Gateway signature not accepted: ${gw.reason}`));
        return;
      }
    }

    // Acknowledge first: the protocol wants a fast ACK, and the message is
    // already proven genuine. Recording is best effort and must not make a
    // valid message look refused.
    res.json(ACK);
    deps.record({ action, body, raw, senderId: sender.subscriberId }).catch((err: unknown) =>
      console.error("[ondc] could not record", action, err instanceof Error ? err.message : String(err)),
    );
  });

  return router;
}
