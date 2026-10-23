import nodemailer from "nodemailer";
import { env, isProd } from "../config/env.js";
import { otpEmail, welcomeEmail, receiptEmail, type OtpPurpose } from "./emailTemplates.js";

const transport =
  env.SMTP_HOST && env.SMTP_PORT
    ? nodemailer.createTransport({
        host: env.SMTP_HOST,
        port: env.SMTP_PORT,
        secure: env.SMTP_PORT === 465,
        auth:
          env.SMTP_USER && env.SMTP_PASS
            ? { user: env.SMTP_USER, pass: env.SMTP_PASS }
            : undefined,
        // Bounded waits: without these nodemailer can hang for minutes on a
        // sick provider, stalling the notification outbox behind it. A timeout
        // surfaces as a send error, so the row simply retries.
        // Kept short because a person is waiting on the other side of some of
        // these. A blocked outbound port — which is the default on several
        // hosts — fails by timing out rather than refusing, so a generous
        // timeout turns a misconfiguration into a twelve second stall on the
        // sign-up button before the error even appears.
        connectionTimeout: 5_000,
        greetingTimeout: 5_000,
        socketTimeout: 10_000,
      })
    : null;

// Brevo's transactional endpoint. Plain HTTPS, so it survives the outbound
// SMTP block that every managed host applies by default.
const BREVO_ENDPOINT = "https://api.brevo.com/v3/smtp/email";
const BREVO_TIMEOUT_MS = 10_000;

/**
 * Splits "Name <address@host>" into the shape Brevo's API wants. A bare
 * address is equally valid and carries no name.
 */
function parseSender(from: string): { email: string; name?: string } {
  const match = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(from);
  const email = match?.[2];
  if (!email) return { email: from.trim() };
  const name = match?.[1];
  return name ? { email, name } : { email };
}

/** True when mail should go over HTTPS rather than SMTP. */
function useHttpApi(): boolean {
  return Boolean(env.BREVO_API_KEY);
}

async function sendViaBrevo(
  to: string,
  mail: { subject: string; html: string; text: string },
): Promise<void> {
  // An unbounded fetch would hold the sign-up request open indefinitely if the
  // provider stalls, which is the failure SMTP already taught us to bound.
  const res = await fetch(BREVO_ENDPOINT, {
    method: "POST",
    headers: {
      "api-key": env.BREVO_API_KEY as string,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      sender: parseSender(env.MAIL_FROM),
      to: [{ email: to }],
      subject: mail.subject,
      htmlContent: mail.html,
      textContent: mail.text,
    }),
    signal: AbortSignal.timeout(BREVO_TIMEOUT_MS),
  });

  if (!res.ok) {
    // Brevo reports the reason in the body, and it is usually actionable — an
    // unverified sender, a spent quota. Carrying it into the thrown error is
    // what makes the difference between a fixable log line and "send failed".
    const detail = await res.text().catch(() => "");
    throw new Error(
      `Brevo rejected the message (${res.status})${detail ? `: ${detail.slice(0, 200)}` : ""}`,
    );
  }
}

/** One way out for every message, whichever transport is configured. */
async function deliver(
  to: string,
  mail: { subject: string; html: string; text: string },
): Promise<void> {
  if (useHttpApi()) return sendViaBrevo(to, mail);
  if (!transport) throw new Error("No mail transport is configured");
  await transport.sendMail({ from: env.MAIL_FROM, to, ...mail });
}

// Test hook: under NODE_ENV=test, codes are captured here instead of sent.
export const otpOutbox: Array<{ to: string; code: string }> = [];

export async function sendOtpEmail(
  to: string,
  code: string,
  purpose: OtpPurpose = "signup",
) {
  if (env.NODE_ENV === "test") {
    otpOutbox.push({ to, code });
    return;
  }
  if (!transport && !useHttpApi()) {
    // Production should never get here (config/env.ts refuses to boot without
    // a transport), and refuses again if it does: a code printed to the log is
    // readable by whoever can read the logs, not only the person signing in.
    if (isProd) throw new Error("No mail transport is configured");
    // Dev mode: no mail configured — surface the code in the server console.
    console.log(`[mailer] OTP for ${to}: ${code}`);
    return;
  }
  await deliver(to, otpEmail(code, purpose));
}

// Non-OTP mail is best-effort: auth and payment flows must never fail because
// an email couldn't be sent, so callers fire-and-forget and errors only log.

export async function sendWelcomeEmail(to: string, name: string) {
  if (env.NODE_ENV === "test" || (!transport && !useHttpApi())) return;
  try {
    await deliver(to, welcomeEmail(name));
  } catch (err) {
    console.error(`[mailer] welcome email to ${to} failed:`, err);
  }
}

// Used by the notification outbox — the worker builds the mail from its
// registry and this just puts it on the wire. Test env is a no-op (the outbox
// records delivery itself for assertions).
export async function sendPrebuiltEmail(
  to: string,
  mail: { subject: string; html: string; text: string },
) {
  if (env.NODE_ENV === "test") return;
  if (!transport && !useHttpApi()) {
    console.log(`[mailer] (no mail transport) would send "${mail.subject}" to ${to}`);
    return;
  }
  await deliver(to, mail);
}

export async function sendReceiptEmail(
  to: string,
  order: { id: string; title: string; domain: string; amount: number; savedPaise: number },
) {
  if (env.NODE_ENV === "test" || (!transport && !useHttpApi())) return;
  try {
    await deliver(to, receiptEmail(order));
  } catch (err) {
    console.error(`[mailer] receipt email to ${to} failed:`, err);
  }
}
