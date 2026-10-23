import { env } from "../../config/env.js";
import { prisma } from "../../lib/prisma.js";
import { createCallbacksRouter, type CallbackDeps } from "./callbacks.routes.js";
import { createRegistryClient, REGISTRY_URL } from "./registryClient.js";
import { applyOnIssue } from "../complaints/igm.network.js";
import { applyRetailReply } from "./orders.service.js";
import { applyRideReply } from "./rides.service.js";
import { applySettlementMessage } from "./settlement.service.js";

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
  let duplicate = false;
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
    if ((err as { code?: string }).code !== "P2002") throw err;
    duplicate = true;
  }
  // A seller's answer to a complaint is applied to it here, duplicate or not:
  // applying is idempotent, and if a first attempt failed after the row was
  // stored, the seller's retry is what gets the complaint updated. A failure
  // throws, so the seller is told to retry.
  if (action === "on_issue") await applyOnIssue({ body, raw, senderId });
  // A food seller's answer about an order, applied on the same terms.
  await applyRetailReply({ action, body, senderId });
  // And a ride provider's, on the same terms.
  await applyRideReply({ action, body, senderId });
  // Settlement: the agency's answers, and seller apps reconciling with us.
  await applySettlementMessage({ action, body, senderId });
  return { duplicate };
};

export function ondcCallbacksRouter() {
  return createCallbacksRouter(ondcCallbackDeps(), { bapId: env.ONDC_SUBSCRIBER_ID });
}
