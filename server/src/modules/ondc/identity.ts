import { env } from "../../config/env.js";
import type { SigningIdentity } from "./signing.js";

/**
 * Who we sign as, for a message in the given domain.
 *
 * ONDC registers each domain subscription with its own key pair and key id:
 * ondc.flouna.com has one for ONDC:RET11 and another for ONDC:TRV10. A message
 * has to be signed with the key registered for its own domain, or a seller app
 * that looks the signer up by domain finds a different key and refuses it.
 *
 * Ride messages use the TRV10 pair when it is set. Everything else (food,
 * grievances on food orders, settlement, registry lookups) uses the default
 * pair, which is also what rides fall back to until the TRV10 pair is set.
 */
export function ondcIdentity(domain?: string): SigningIdentity | null {
  const subscriberId = env.ONDC_SUBSCRIBER_ID;
  if (!subscriberId) return null;
  if (domain === "ONDC:TRV10" && env.ONDC_UNIQUE_KEY_ID_TRV10 && env.ONDC_SIGNING_PRIVATE_KEY_TRV10) {
    return { subscriberId, uniqueKeyId: env.ONDC_UNIQUE_KEY_ID_TRV10, signingPrivateKey: env.ONDC_SIGNING_PRIVATE_KEY_TRV10 };
  }
  return env.ONDC_UNIQUE_KEY_ID && env.ONDC_SIGNING_PRIVATE_KEY
    ? { subscriberId, uniqueKeyId: env.ONDC_UNIQUE_KEY_ID, signingPrivateKey: env.ONDC_SIGNING_PRIVATE_KEY }
    : null;
}
