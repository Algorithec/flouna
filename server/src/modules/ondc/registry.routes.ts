import crypto from "node:crypto";
import { Router } from "express";
import { env } from "../../config/env.js";
import { answerChallenge, encryptionKeyFrom, signingKeyFrom } from "./keys.js";

// The two things the ONDC registry asks of a subscriber's own domain, before
// any order flows: proof that we control it, and proof that we hold the
// encryption key we registered.
//
// Served from the root of ondc.flouna.com, not under /api, because the
// registry builds both URLs from the subscriber id itself:
//   https://<subscriber_id>/ondc-site-verification.html
//   https://<subscriber_id>/ondc/on_subscribe
//
// The keys come from the file the ONDC portal issues at subscription and live
// only in Railway's environment. Without them these routes answer 404 rather
// than serve something that would fail verification in a way that looks like
// our bug.

// Published by ONDC in developer-docs/registry/Onboarding of Participants.md.
const REGISTRY_ENCRYPTION_PUBLIC_KEY = {
  preprod: "MCowBQYDK2VuAyEARa/WcMCzNQp4DWjvTI4DK7vHL6EdaHqN4GjFIu9wxxM=",
  prod: "MCowBQYDK2VuAyEAwASk2D4O3p/tuD8f9sNQAQlwOU2w3DAumcOK9qHCFwI=",
} as const;

export const ondcRegistryRouter = Router();

ondcRegistryRouter.get("/ondc-site-verification.html", (_req, res) => {
  if (!env.ONDC_SIGNING_PRIVATE_KEY || !env.ONDC_SITE_REQUEST_ID) {
    res.status(404).send("Not configured");
    return;
  }
  const signed = crypto
    .sign(null, Buffer.from(env.ONDC_SITE_REQUEST_ID), signingKeyFrom(env.ONDC_SIGNING_PRIVATE_KEY))
    .toString("base64");
  res
    .type("html")
    .send(
      `<html>\n  <head>\n    <meta name='ondc-site-verification' content='${signed}' />\n  </head>\n  <body>\n    ONDC Site Verification Page\n  </body>\n</html>\n`,
    );
});

ondcRegistryRouter.post("/ondc/on_subscribe", (req, res) => {
  const challenge = (req.body as { challenge?: unknown } | undefined)?.challenge;
  if (!env.ONDC_ENCRYPTION_PRIVATE_KEY) {
    res.status(404).json({ error: "Not configured" });
    return;
  }
  if (typeof challenge !== "string" || challenge.length === 0 || challenge.length > 2048) {
    res.status(400).json({ error: "Missing challenge" });
    return;
  }
  // One key per subscription. The portal issues a fresh pair for every
  // domain subscribed under ondc.flouna.com, and the challenge is encrypted to
  // whichever one the registry is checking, so each is tried in turn. A wrong
  // key fails AES padding rather than producing a plausible answer.
  const registryPublic =
    process.env.ONDC_REGISTRY_ENCRYPTION_PUBLIC_KEY ??
    REGISTRY_ENCRYPTION_PUBLIC_KEY[env.ONDC_REGISTRY_ENV];
  for (const key of env.ONDC_ENCRYPTION_PRIVATE_KEY.split(",").map((k) => k.trim()).filter(Boolean)) {
    try {
      res.json({ answer: answerChallenge(challenge, encryptionKeyFrom(key), registryPublic) });
      return;
    } catch {
      // Not this subscription's key; try the next.
    }
  }
  // None of our keys decrypts it: the registry's record and ours disagree.
  // Say so plainly rather than as a server fault.
  res.status(400).json({ error: "Could not decrypt the challenge" });
});
