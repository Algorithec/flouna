import { Router, type Request } from "express";
import { BAP_ID } from "./context.js";
import { BUYER_ERRORS, nack } from "./errors.js";
import { digestOf, headerShape, parseAuthorizationHeader, verifyAuthorizationHeader, type VerifyResult } from "./signing.js";

/**
 * One line per refused message: which action, who it claimed to be from, and
 * why. Without it a seller whose answers were all refused looked, from our
 * side, like a seller who never answered.
 */
export function refused(action: string, header: string | undefined, reason: string) {
  const parsed = header ? parseAuthorizationHeader(header) : null;
  const from = parsed ? `${parsed.subscriberId}|${parsed.uniqueKeyId}` : headerShape(header);
  console.warn(`[ondc] refused ${action} from ${from}: ${reason}`);
}

/** A message outside its signature's time window is stale; anything else is an invalid signature. */
function signatureError(reason: Extract<VerifyResult, { ok: false }>["reason"]) {
  return reason === "expired" || reason === "not_yet_valid" ? BUYER_ERRORS.STALE_REQUEST : BUYER_ERRORS.INVALID_SIGNATURE;
}

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
  // Complaints (IGM). Seller apps send these to the same base URL as every
  // other answer, so without them a seller's reply to a complaint was a 404.
  "on_issue",
  "on_issue_status",
] as const;

export type ReceivedCallback = {
  action: string;
  body: Record<string, unknown>;
  raw: string;
  senderId: string;
  /** Signer and digest of the exact bytes: the same for every copy of one message. */
  dedupeKey: string;
};

export type CallbackDeps = {
  /** Registered signing key for a subscriber and key id, or null. */
  publicKeyFor: (subscriberId: string, uniqueKeyId: string) => Promise<string | null>;
  /**
   * Persists a verified message. If it throws, the message is refused with a
   * NACK so the seller app sends it again: an order confirmation we
   * acknowledged but never stored would be lost for good.
   */
  record: (cb: ReceivedCallback) => Promise<RecordOutcome | void>;
};

/** `duplicate` when this exact message was already stored, by this server or another. */
export type RecordOutcome = { duplicate: boolean };

const ACK = { message: { ack: { status: "ACK" } } };

export function createCallbacksRouter(deps: CallbackDeps | null, opts: { bapId?: string } = {}) {
  const router = Router();
  // Messages addressed to any other buyer app are refused.
  const bapId = opts.bapId ?? BAP_ID;
  // Messages being stored right now. A second copy that arrives meanwhile
  // waits on the first instead of racing it to the database. Copies that
  // arrive later, or at another server, are caught by the stored row's
  // unique dedupe key instead.
  const storing = new Map<string, Promise<RecordOutcome | void>>();

  router.post("/ondc/:action", async (req: Request, res, next) => {
    const action = req.params.action ?? "";
    // on_subscribe belongs to the registry handshake, handled before this.
    if (!(CALLBACK_ACTIONS as readonly string[]).includes(action)) return next();

    if (!deps) {
      res.status(503).json(nack(BUYER_ERRORS.INTERNAL_ERROR, "ONDC is not configured on this deployment"));
      return;
    }

    // The signature covers the bytes as sent. Decoding them to a string and
    // back would alter anything that is not valid UTF-8, and a genuine
    // message would then fail to verify.
    const rawBytes = (req as Request & { rawBody?: Buffer }).rawBody;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const ctx = (body.context ?? {}) as Record<string, unknown>;
    if (!rawBytes?.length || ctx.action !== action) {
      res.status(400).json(nack(BUYER_ERRORS.INVALID_RESPONSE, "Context action does not match the endpoint"));
      return;
    }
    if (ctx.bap_id !== bapId) {
      res.status(400).json(nack(BUYER_ERRORS.INVALID_RESPONSE, "Message is not addressed to this buyer app"));
      return;
    }

    try {
      const sender = await verifyAuthorizationHeader(req.get("authorization"), rawBytes, deps.publicKeyFor);
      if (!sender.ok) {
        refused(action, req.get("authorization"), sender.reason);
        res.status(401).json(nack(signatureError(sender.reason), `Signature not accepted: ${sender.reason}`));
        return;
      }
      // A valid signature only proves who sent the message. Without this, any
      // registered participant could sign an on_confirm naming another seller
      // in its context and have it taken as that seller's.
      if (ctx.bpp_id !== sender.subscriberId) {
        refused(action, req.get("authorization"), `signer ${sender.subscriberId} is not bpp_id ${String(ctx.bpp_id)}`);
        res.status(401).json(nack(BUYER_ERRORS.INVALID_SIGNATURE, "Signer is not the seller app named in the message"));
        return;
      }
      const gatewayHeader = req.get("x-gateway-authorization");
      if (gatewayHeader) {
        const gw = await verifyAuthorizationHeader(gatewayHeader, rawBytes, deps.publicKeyFor);
        if (!gw.ok) {
          refused(action, gatewayHeader, `gateway ${gw.reason}`);
          res.status(401).json(nack(signatureError(gw.reason), `Gateway signature not accepted: ${gw.reason}`));
          return;
        }
      }

      // Stored before the ACK, so an ACK always means we have it. A copy of a
      // message already stored is acknowledged too: the seller evidently did
      // not see our first ACK, and storing it again would record it twice.
      const dedupeKey = `${sender.subscriberId}|${digestOf(rawBytes)}`;
      let pending = storing.get(dedupeKey);
      if (!pending) {
        pending = deps
          .record({ action, body, raw: rawBytes.toString("utf8"), senderId: sender.subscriberId, dedupeKey })
          .finally(() => storing.delete(dedupeKey));
        storing.set(dedupeKey, pending);
      }
      await pending;
      res.json(ACK);
    } catch (err) {
      // A registry key that is not a key, a lookup that throws, a database
      // that is down: refuse the message so the seller app retries it, rather
      // than leave the request open until the seller gives up.
      console.error("[ondc] could not take", action, err instanceof Error ? err.message : String(err));
      if (!res.headersSent) res.status(500).json(nack(BUYER_ERRORS.INTERNAL_ERROR, "Could not process the message, retry"));
    }
  });

  return router;
}
