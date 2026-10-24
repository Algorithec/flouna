import { afterEach, describe, expect, it, vi } from "vitest";

// A login code belongs to the person signing in. In development, with no mail
// set up, printing it to the console is how a developer signs in at all. In
// production the same line would hand it to anyone who can read the logs, so
// the mailer refuses there, even though the boot gate should already make the
// branch unreachable.

const CODE = "482913";

async function mailerUnder(nodeEnv: "production" | "development") {
  vi.resetModules();
  vi.doMock("../src/config/env.js", () => ({
    env: {
      NODE_ENV: nodeEnv,
      MAIL_FROM: "Flouna <no-reply@flouna.app>",
      WEB_ORIGIN: "https://www.flouna.com",
    },
    isProd: nodeEnv === "production",
  }));
  return import("../src/lib/mailer.js");
}

describe("login codes with no mail transport", () => {
  afterEach(() => {
    vi.doUnmock("../src/config/env.js");
    vi.restoreAllMocks();
  });

  it("are never printed in production", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { sendOtpEmail } = await mailerUnder("production");
    await expect(sendOtpEmail("asha@example.com", CODE)).rejects.toThrow(/no mail transport/i);
    expect(log.mock.calls.flat().join(" ")).not.toContain(CODE);
  });

  it("are printed in development, where that is how anyone signs in", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { sendOtpEmail } = await mailerUnder("development");
    await sendOtpEmail("asha@example.com", CODE);
    expect(log.mock.calls.flat().join(" ")).toContain(CODE);
  });
});
