import jwt from "jsonwebtoken";
import { describe, expect, it } from "vitest";
import { env } from "../src/config/env.js";
import { signAccessToken, verifyAccessToken } from "../src/lib/tokens.js";

// Access tokens are signed and checked with HS256 only. The algorithm is in the
// token's header, which the client sends; without naming it on our side, the
// library checks the signature with whatever HMAC algorithm that header asks for.

describe("access token algorithm", () => {
  it("signs with HS256 and accepts its own tokens", () => {
    const token = signAccessToken("user-1", "user");
    expect(JSON.parse(Buffer.from(token.split(".")[0]!, "base64url").toString()).alg).toBe("HS256");
    expect(verifyAccessToken(token)?.sub).toBe("user-1");
  });

  it("refuses a token whose header names another algorithm", () => {
    for (const algorithm of ["HS384", "HS512"] as const) {
      const token = jwt.sign({ sub: "user-1", role: "super_admin", step: true }, env.JWT_ACCESS_SECRET, { algorithm });
      expect(verifyAccessToken(token), algorithm).toBeNull();
    }
  });

  it("refuses an unsigned token", () => {
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    const body = Buffer.from(JSON.stringify({ sub: "user-1", role: "super_admin", step: true })).toString("base64url");
    expect(verifyAccessToken(`${header}.${body}.`)).toBeNull();
  });
});
