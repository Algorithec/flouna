import { randomUUID } from "node:crypto";
import { env, isProd } from "../config/env.js";

// Error monitoring. Every unexpected error is logged, and when SENTRY_DSN is
// set it is also posted to Sentry.
//
// No SDK: an event is one HTTP request to Sentry's envelope endpoint, which
// is documented and stable, and doing it here keeps a dependency, its
// instrumentation and its lockfile churn out of the API. Three rules shape it:
//   - Reporting must never be the outage. It never throws, never makes a
//     request wait, and gives up after a few seconds.
//   - An error message can carry a customer's email or phone number (a unique
//     constraint on User.email quotes the value), so both are removed before
//     anything leaves the server.
//   - An error storm sends a capped number of events a minute rather than
//     thousands, which would exhaust the plan's quota in the hour it matters.

export function parseDsn(dsn: string): { envelopeUrl: string; publicKey: string } | null {
  try {
    const u = new URL(dsn);
    const projectId = u.pathname.replace(/^\/+|\/+$/g, "");
    if (!u.username || !projectId) return null;
    return {
      envelopeUrl: `${u.protocol}//${u.host}/api/${projectId}/envelope/`,
      publicKey: decodeURIComponent(u.username),
    };
  } catch {
    return null;
  }
}

/** Emails and phone-like digit runs, replaced before anything is sent. */
function scrub(text: string): string {
  return text
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
    .replace(/(?<!\d)\+?\d[\d -]{8,}\d(?!\d)/g, "[number]");
}

export function createReporter(opts: {
  dsn: string | undefined;
  environment: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  perMinute?: number;
}) {
  const target = opts.dsn ? parseDsn(opts.dsn) : null;
  const send = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  const perMinute = opts.perMinute ?? 30;
  let windowStart = 0;
  let sentInWindow = 0;

  async function capture(err: unknown, context: Record<string, unknown> = {}): Promise<void> {
    if (!target) return;
    const t = now();
    if (t - windowStart >= 60_000) {
      windowStart = t;
      sentInWindow = 0;
    }
    if (sentInWindow >= perMinute) return;
    sentInWindow++;

    const eventId = randomUUID().replace(/-/g, "");
    const error = err instanceof Error ? err : new Error(String(err));
    const event = {
      event_id: eventId,
      timestamp: t / 1000,
      platform: "node",
      level: "error",
      environment: opts.environment,
      exception: {
        values: [
          {
            type: error.name,
            value: scrub(error.message),
            ...(error.stack ? { stacktrace: { frames: framesOf(error.stack) } } : {}),
          },
        ],
      },
      extra: JSON.parse(scrub(JSON.stringify(context))) as Record<string, unknown>,
    };
    const body = [
      JSON.stringify({ event_id: eventId, sent_at: new Date(t).toISOString() }),
      JSON.stringify({ type: "event" }),
      JSON.stringify(event),
    ].join("\n");
    try {
      await send(target.envelopeUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-sentry-envelope",
          "X-Sentry-Auth": `Sentry sentry_version=7, sentry_key=${target.publicKey}, sentry_client=flouna-api/1.0`,
        },
        body,
        signal: AbortSignal.timeout(3000),
      });
    } catch {
      // Sentry being unreachable is not worth a second error.
    }
  }

  return { enabled: Boolean(target), capture };
}

/** Stack lines to Sentry frames, innermost last as Sentry expects. */
function framesOf(stack: string) {
  return stack
    .split("\n")
    .slice(1)
    .map((line) => line.trim().match(/^at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/))
    .filter((m): m is RegExpMatchArray => Boolean(m))
    .map((m) => ({
      function: m[1] ?? "<anonymous>",
      filename: m[2]!.replace(/^file:\/\//, ""),
      lineno: Number(m[3]),
      colno: Number(m[4]),
      in_app: !m[2]!.includes("node_modules") && !m[2]!.startsWith("node:"),
    }))
    .reverse();
}

const reporter = createReporter({ dsn: env.SENTRY_DSN, environment: env.NODE_ENV });
export const monitoringEnabled = reporter.enabled;

export function initMonitoring(): void {
  if (env.SENTRY_DSN && !reporter.enabled) {
    console.warn("[monitoring] SENTRY_DSN is set but could not be read, so errors stay console-only");
    return;
  }
  if (!monitoringEnabled) {
    if (isProd) console.warn("[monitoring] SENTRY_DSN unset, error monitoring is console-only");
    return;
  }
  console.info("[monitoring] errors are reported to Sentry");
}

// Report an unexpected error with optional context (route, method, kind).
export function captureError(err: unknown, context?: Record<string, unknown>): void {
  const payload = {
    message: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
    ...context,
    at: new Date().toISOString(),
  };
  console.error("[error]", JSON.stringify(payload));
  void reporter.capture(err, context);
}
