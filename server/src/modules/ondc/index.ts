import { env } from "../../config/env.js";
import { prisma } from "../../lib/prisma.js";
import { createCallbacksRouter, type CallbackDeps } from "./callbacks.routes.js";
import { createRegistryClient, REGISTRY_URL } from "./registryClient.js";

/**
 * The live ONDC wiring, or null when this deployment has no ONDC identity.
 * Null makes every callback answer "not configured" rather than accept
 * messages it cannot verify.
 */
export function ondcCallbackDeps(): CallbackDeps | null {
  if (!env.ONDC_SUBSCRIBER_ID || !env.ONDC_UNIQUE_KEY_ID || !env.ONDC_SIGNING_PRIVATE_KEY) return null;
  const registry = createRegistryClient({
    registryUrl: REGISTRY_URL[env.ONDC_REGISTRY_ENV],
    identity: {
      subscriberId: env.ONDC_SUBSCRIBER_ID,
      uniqueKeyId: env.ONDC_UNIQUE_KEY_ID,
      signingPrivateKey: env.ONDC_SIGNING_PRIVATE_KEY,
    },
  });
  return { publicKeyFor: registry.publicKeyFor, record: recordInbound };
}

/**
 * Stores a verified inbound message. The row's unique dedupe key makes a
 * resend of the same bytes a no-op, wherever and whenever it arrives.
 */
export const recordInbound: CallbackDeps["record"] = async ({ action, body, raw, senderId, dedupeKey }) => {
  const ctx = (body.context ?? {}) as Record<string, string | undefined>;
  try {
    await prisma.ondcTransaction.create({
      data: {
        txnId: ctx.transaction_id ?? "unknown",
        messageId: ctx.message_id ?? "unknown",
        action,
        domain: ctx.domain ?? "unknown",
        // The verified signer, never the context, which the sender writes.
        bppId: senderId,
        response: raw,
        status: "ack",
        signed: true,
        simulated: false,
        dedupeKey,
      },
    });
  } catch (err) {
    // The unique dedupe key: this exact message is already stored.
    if ((err as { code?: string }).code === "P2002") return { duplicate: true };
    throw err;
  }
  return { duplicate: false };
};

export function ondcCallbacksRouter() {
  return createCallbacksRouter(ondcCallbackDeps(), { bapId: env.ONDC_SUBSCRIBER_ID });
}
