import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";

// The production gate is the last thing standing between a dev-shaped config
// and real users. Its worst failure mode is silence, so these tests assert it
// actually refuses — particularly for simulated fulfilment, which would show a
// rider a captain, an OTP and a moving vehicle that do not exist.

const SAFE_PROD = {
  NODE_ENV: "production",
  DATABASE_URL: "postgresql://user:pass@localhost:5432/flouna",
  WEB_ORIGIN: "https://flouna.app",
  JWT_ACCESS_SECRET: "a".repeat(48),
  JWT_REFRESH_SECRET: "b".repeat(48),
  PROVIDER_MODE: "ondc",
  ONDC_SUBSCRIBER_ID: "ondc.flouna.com",
  CASHFREE_APP_ID: "app-id",
  CASHFREE_SECRET_KEY: "secret-key",
  CASHFREE_ENV: "production",
  LLM_PROVIDER: "deepseek",
  VAPID_PUBLIC_KEY: "vapid-public",
};

/** Load config/env.ts fresh under the given environment. */
async function loadEnv(overrides: Record<string, string | undefined>) {
  const saved = { ...process.env };
  for (const [k, v] of Object.entries({ ...SAFE_PROD, ...overrides })) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.resetModules();
  const exit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("__exit__");
  }) as never);
  const errors: string[] = [];
  const warns: string[] = [];
  vi.spyOn(console, "error").mockImplementation((m) => void errors.push(String(m)));
  vi.spyOn(console, "warn").mockImplementation((m) => void warns.push(String(m)));

  let exited = false;
  try {
    // vi.resetModules() above clears the registry, so this re-executes the
    // module body — and with it the gate — under the env set for this case.
    await import("../src/config/env.js");
  } catch (err) {
    if ((err as Error).message === "__exit__") exited = true;
    else throw err;
  } finally {
    exit.mockRestore();
    vi.restoreAllMocks();
    process.env = saved;
  }
  return { exited, errors, warns };
}

describe("production config gate", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.restoreAllMocks());

  it("a fully configured production environment starts", async () => {
    const { exited } = await loadEnv({});
    expect(exited).toBe(false);
  });

  it("refuses to start with simulated fulfilment — no invented drivers in production", async () => {
    const { exited, errors } = await loadEnv({ PROVIDER_MODE: "simulation" });
    expect(exited).toBe(true);
    expect(errors.join(" ")).toMatch(/fabricates drivers/i);
  });

  it("refuses ONDC mode without a subscriber ID", async () => {
    const { exited, errors } = await loadEnv({ ONDC_SUBSCRIBER_ID: undefined });
    expect(exited).toBe(true);
    expect(errors.join(" ")).toMatch(/ONDC_SUBSCRIBER_ID/);
  });

  it("refuses a subscriber id other than the one its ONDC messages carry", async () => {
    const { exited, errors } = await loadEnv({ ONDC_SUBSCRIBER_ID: "www.flouna.com" });
    expect(exited).toBe(true);
    expect(errors.join(" ")).toMatch(/would be refused/);
  });

  it("refuses to start without payment credentials — checkout would dead-end", async () => {
    for (const missing of ["CASHFREE_APP_ID", "CASHFREE_SECRET_KEY"]) {
      const { exited, errors } = await loadEnv({ [missing]: undefined });
      expect(exited).toBe(true);
      expect(errors.join(" ")).toMatch(/dead-end/i);
    }
  });

  it("still refuses a SQLite database, weak secrets and a plain-http origin", async () => {
    expect((await loadEnv({ DATABASE_URL: "file:./dev.db" })).exited).toBe(true);
    expect((await loadEnv({ JWT_ACCESS_SECRET: "short" })).exited).toBe(true);
    expect((await loadEnv({ WEB_ORIGIN: "http://flouna.app" })).exited).toBe(true);
  });

  it("warns without refusing when a feature is merely switched off", async () => {
    const { exited, warns } = await loadEnv({ LLM_PROVIDER: "demo" });
    expect(exited).toBe(false);
    expect(warns.join(" ")).toMatch(/rule-based/i);

    const push = await loadEnv({ VAPID_PUBLIC_KEY: undefined });
    expect(push.exited).toBe(false);
    expect(push.warns.join(" ")).toMatch(/push/i);

    const sandbox = await loadEnv({ CASHFREE_ENV: "sandbox" });
    expect(sandbox.exited).toBe(false);
    expect(sandbox.warns.join(" ")).toMatch(/not real money/i);
  });

  it("leaves development alone — simulation is the point in dev", async () => {
    const { exited } = await loadEnv({
      NODE_ENV: "development",
      PROVIDER_MODE: "simulation",
      DATABASE_URL: "file:./dev.db",
      CASHFREE_APP_ID: undefined,
      CASHFREE_SECRET_KEY: undefined,
    });
    expect(exited).toBe(false);
  });
});
