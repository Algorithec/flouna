import { describe, expect, it, vi } from "vitest";
import { createReporter, parseDsn } from "../src/lib/monitoring.js";

// Error reporting to Sentry, without the SDK: the event is posted to Sentry's
// envelope endpoint. These check what is sent, what is kept out of it, and
// that reporting can never become the outage.

const DSN = "https://abc123@o42.ingest.sentry.io/7";

function fakeFetch(impl?: () => Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return impl ? impl() : new Response("{}", { status: 200 });
  });
  return { calls, fn: fn as unknown as typeof fetch };
}

describe("reading the DSN", () => {
  it("finds the envelope endpoint and the public key", () => {
    expect(parseDsn(DSN)).toEqual({
      envelopeUrl: "https://o42.ingest.sentry.io/api/7/envelope/",
      publicKey: "abc123",
    });
  });

  it("returns null for a DSN it cannot read, rather than throwing at boot", () => {
    expect(parseDsn("not a url")).toBeNull();
    expect(parseDsn("https://o42.ingest.sentry.io/7")).toBeNull();
  });
});

describe("reporting an error", () => {
  it("posts an event to the envelope endpoint with the key in the auth header", async () => {
    const f = fakeFetch();
    const r = createReporter({ dsn: DSN, environment: "production", fetchImpl: f.fn });
    await r.capture(new TypeError("boom"), { path: "/api/orders", method: "POST" });

    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.url).toBe("https://o42.ingest.sentry.io/api/7/envelope/");
    const headers = f.calls[0]!.init.headers as Record<string, string>;
    expect(headers["X-Sentry-Auth"]).toContain("sentry_key=abc123");
    const [header, item, payload] = String(f.calls[0]!.init.body).split("\n");
    expect(JSON.parse(item!).type).toBe("event");
    const event = JSON.parse(payload!);
    expect(JSON.parse(header!).event_id).toBe(event.event_id);
    expect(event.environment).toBe("production");
    expect(event.exception.values[0]).toMatchObject({ type: "TypeError", value: "boom" });
    expect(event.extra).toEqual({ path: "/api/orders", method: "POST" });
  });

  it("keeps email addresses and phone numbers out of what it sends", async () => {
    const f = fakeFetch();
    const r = createReporter({ dsn: DSN, environment: "production", fetchImpl: f.fn });
    await r.capture(new Error("Unique constraint failed for priya@example.com, phone 9876543210"));
    const body = String(f.calls[0]!.init.body);
    expect(body).not.toContain("priya@example.com");
    expect(body).not.toContain("9876543210");
    expect(body).toContain("[email]");
  });

  it("never throws when Sentry is down", async () => {
    const f = fakeFetch(async () => {
      throw new TypeError("fetch failed");
    });
    const r = createReporter({ dsn: DSN, environment: "production", fetchImpl: f.fn });
    await expect(r.capture(new Error("x"))).resolves.toBeUndefined();
  });

  it("stops sending in an error storm instead of flooding the account", async () => {
    const f = fakeFetch();
    let now = 1_000_000;
    const r = createReporter({ dsn: DSN, environment: "production", fetchImpl: f.fn, now: () => now, perMinute: 5 });
    for (let i = 0; i < 20; i++) await r.capture(new Error(`e${i}`));
    expect(f.calls).toHaveLength(5);
    now += 61_000;
    await r.capture(new Error("after the minute"));
    expect(f.calls).toHaveLength(6);
  });

  it("sends nothing without a DSN", async () => {
    const f = fakeFetch();
    const r = createReporter({ dsn: undefined, environment: "development", fetchImpl: f.fn });
    await r.capture(new Error("x"));
    expect(f.calls).toHaveLength(0);
    expect(r.enabled).toBe(false);
  });
});
