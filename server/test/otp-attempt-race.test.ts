import { describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";
import { createOtp, consumeOtp } from "../src/modules/auth/otp.js";

// A one-time code allows five guesses, and the five has to hold when the
// guesses arrive together.
//
// The count was read, the guess checked, and the count incremented afterwards.
// Guesses sent at the same moment all read "fewer than five" and were all
// checked, so the cap only limited people guessing politely, one at a time.
// The code that matters most here is the password reset one: guessing it is
// taking over the account.

function target() {
  return `race-${Date.now()}-${Math.random().toString(36).slice(2)}@test.dev`;
}

describe("the guess limit on a one-time code", () => {
  it("checks at most five guesses, however many arrive together", async () => {
    const email = target();
    await createOtp({ channel: "email", target: email, purpose: "reset" });

    const spy = vi.spyOn(bcrypt, "compare");
    try {
      const results = await Promise.all(
        Array.from({ length: 30 }, (_, i) =>
          consumeOtp({ target: email, purpose: "reset", code: String(100000 + i).padStart(6, "0") }),
        ),
      );
      expect(results.every((r) => r === false)).toBe(true);
      expect(spy.mock.calls.length).toBeLessThanOrEqual(5);
    } finally {
      spy.mockRestore();
    }
  });

  it("refuses even the right code once its guesses are spent", async () => {
    const email = target();
    const code = await createOtp({ channel: "email", target: email, purpose: "reset" });
    await Promise.all(
      Array.from({ length: 12 }, () => consumeOtp({ target: email, purpose: "reset", code: "000000" })),
    );
    expect(await consumeOtp({ target: email, purpose: "reset", code })).toBe(false);
  });

  it("lets a code be used only once, even by two requests at the same moment", async () => {
    const email = target();
    const code = await createOtp({ channel: "email", target: email, purpose: "reset" });
    const results = await Promise.all([
      consumeOtp({ target: email, purpose: "reset", code }),
      consumeOtp({ target: email, purpose: "reset", code }),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("still accepts the right code on a normal first try", async () => {
    const email = target();
    const code = await createOtp({ channel: "email", target: email, purpose: "reset" });
    expect(await consumeOtp({ target: email, purpose: "reset", code })).toBe(true);
  });
});
