import { Router, json as expressJson } from "express";
import { env } from "../../config/env.js";
import {
  igmAdapter,
  applyInboundEvent,
  callbackVerificationConfigured,
  verifyCallbackSignature,
  type IgmAction,
  type InboundIgmEvent,
} from "./igm.adapter.js";

// Inbound ONDC IGM callbacks: on_issue and on_issue_status.
//
// Mounted outside /api because these are network endpoints, not app endpoints —
// they carry no session and must never be reachable with a user's cookie.
//
// Three properties matter here more than anything else:
//
//   1. Fail closed. Signature verification is not implemented, so in production
//      these refuse everything. An open webhook that anyone could POST a
//      resolution or a refund to is a far worse defect than an unfinished
//      integration.
//   2. Idempotent. The guide warns duplicates will arrive; a repeat must not
//      log twice, advance the case twice, or create a second refund.
//   3. Always acknowledged in protocol terms. A malformed or unknown-complaint
//      message is recorded and answered, not retried forever.
export const igmWebhookRouter = Router();

// Raw body is captured so a signature can be checked over exactly the bytes
// received, once the scheme is known — re-serialising parsed JSON would not
// reproduce them.
igmWebhookRouter.use(
  expressJson({
    limit: "1mb",
    verify: (req, _res, buf) => {
      (req as { rawBody?: string }).rawBody = buf.toString("utf8");
    },
  }),
);

function handler(action: IgmAction) {
  return async (
    req: Parameters<Parameters<Router["post"]>[1]>[0],
    res: Parameters<Parameters<Router["post"]>[1]>[1],
  ) => {
    try {
      const raw = (req as unknown as { rawBody?: string }).rawBody ?? "";

      if (!verifyCallbackSignature(req.headers, raw)) {
        // 401, not 500: the message was understood and refused.
        res.status(401).json({
          message: { ack: { status: "NACK" } },
          error: {
            code: "UNAUTHORISED",
            message: callbackVerificationConfigured()
              ? "Signature verification failed"
              : "ONDC signature verification is not configured on this deployment",
          },
        });
        return;
      }

      const event: InboundIgmEvent | null = igmAdapter.parseCallback(
        action,
        req.body,
      );
      if (!event) {
        res.status(400).json({
          message: { ack: { status: "NACK" } },
          error: {
            code: "UNPARSEABLE",
            message:
              "Callback could not be interpreted, the IGM specification is not wired up yet",
          },
        });
        return;
      }

      const result = await applyInboundEvent(action, event, req.body);

      // A duplicate is a success from the network's point of view: it asked us to
      // record something we have already recorded. NACKing would invite retries.
      res.json({
        message: { ack: { status: "ACK" } },
        ...(result.applied ? {} : { note: result.reason }),
        ...(env.NODE_ENV === "production" ? {} : { unverified: !callbackVerificationConfigured() }),
      });
    } catch (err) {
      // This router is mounted without the error middleware's reach: nothing
      // awaited the handler, so a throw anywhere in it (a database fault inside
      // applyInboundEvent, or the deliberate "not implemented" from the
      // signature verifier once keys are configured) became an unhandled
      // rejection and the network got no reply at all — it then retried the
      // same callback for ever. NACK is the honest answer: we understood it and
      // could not record it, so sending it again is the right thing to do.
      console.error(
        `[igm] ${action} callback failed:`,
        err instanceof Error ? err.message : String(err),
      );
      res.status(500).json({
        message: { ack: { status: "NACK" } },
        error: {
          code: "INTERNAL_ERROR",
          message: "Could not record that callback",
        },
      });
    }
  };
}

igmWebhookRouter.post("/on-issue", handler("on_issue"));
igmWebhookRouter.post("/on-issue-status", handler("on_issue_status"));
