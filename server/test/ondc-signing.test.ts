import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createAuthorizationHeader,
  digestOf,
  signingString,
  verifyAuthorizationHeader,
} from "../src/modules/ondc/signing.js";
import { createRegistryClient, type Participant } from "../src/modules/ondc/registryClient.js";

// ONDC rejects a request whose signature it cannot reproduce, and says nothing
// useful about why. These tests pin the format to ONDC's own published example
// and then attack the verifier the way a forged or replayed message would.

const ED_SPKI = Buffer.from("302a300506032b6570032100", "hex");
const pubFromRaw = (b64: string) =>
  crypto.createPublicKey({ key: Buffer.concat([ED_SPKI, Buffer.from(b64, "base64")]), format: "der", type: "spki" });

function identity() {
  const kp = crypto.generateKeyPairSync("ed25519");
  const seed = kp.privateKey.export({ type: "pkcs8", format: "der" }).subarray(-32);
  const pub = kp.publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64");
  return {
    id: { subscriberId: "ondc.flouna.com", uniqueKeyId: "uk-1", signingPrivateKey: seed.toString("base64") },
    pub,
  };
}

describe("ONDC signing format", () => {
  it("reproduces ONDC's published example signature exactly", () => {
    // From ONDC-Official/developer-docs, registry/signing-verification.md.
    const s = signingString(
      1641287875,
      1641291475,
      "b6lf6lRgOweajukcvcLsagQ2T60+85kRh/Rd2bdS+TG/5ALebOEgDJfyCrre/1+BMu5nA94o4DT3pTFXuUg7sw==",
    );
    const ok = crypto.verify(
      null,
      Buffer.from(s),
      pubFromRaw("awGPjRK6i/Vg/lWr+0xObclVxlwZXvTjWYtlu6NeOHk="),
      Buffer.from("cjbhP0PFyrlSCNszJM1F/YmHDVAWsZqJUPzojnE/7TJU3fJ/rmIlgaUHEr5E0/2PIyf0tpSnWtT6cyNNlpmoAQ==", "base64"),
    );
    expect(ok).toBe(true);
  });

  it("digests the exact bytes with BLAKE2b-512", () => {
    expect(Buffer.from(digestOf("{}"), "base64")).toHaveLength(64);
    expect(digestOf('{"a":1}')).not.toBe(digestOf('{"a": 1}'));
  });
});

describe("verifying a signed request", () => {
  const body = JSON.stringify({ context: { action: "on_search" }, message: { catalog: {} } });
  const now = 1_800_000_000;

  it("accepts what we signed", async () => {
    const { id, pub } = identity();
    const header = createAuthorizationHeader(body, id, now);
    expect(header).toContain('keyId="ondc.flouna.com|uk-1|ed25519"');
    const res = await verifyAuthorizationHeader(header, body, async () => pub, now);
    expect(res).toEqual({ ok: true, subscriberId: "ondc.flouna.com", uniqueKeyId: "uk-1" });
  });

  it("refuses a body changed after signing", async () => {
    const { id, pub } = identity();
    const header = createAuthorizationHeader(body, id, now);
    const tampered = body.replace("on_search", "on_confirm");
    expect(await verifyAuthorizationHeader(header, tampered, async () => pub, now)).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("refuses a signature from a different key than the registry holds", async () => {
    const signer = identity();
    const other = identity();
    const header = createAuthorizationHeader(body, signer.id, now);
    expect(await verifyAuthorizationHeader(header, body, async () => other.pub, now)).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("refuses an expired or not-yet-valid signature, and an unknown key", async () => {
    const { id, pub } = identity();
    const header = createAuthorizationHeader(body, id, now);
    expect(await verifyAuthorizationHeader(header, body, async () => pub, now + 3600 + 120)).toEqual({ ok: false, reason: "expired" });
    expect(await verifyAuthorizationHeader(header, body, async () => pub, now - 600)).toEqual({ ok: false, reason: "not_yet_valid" });
    expect(await verifyAuthorizationHeader(header, body, async () => null, now)).toEqual({ ok: false, reason: "unknown_key" });
  });

  it("refuses a header that claims another algorithm, or none at all", async () => {
    const { id, pub } = identity();
    const header = createAuthorizationHeader(body, id, now).replace('algorithm="ed25519"', 'algorithm="rsa"');
    expect(await verifyAuthorizationHeader(header, body, async () => pub, now)).toEqual({ ok: false, reason: "algorithm" });
    expect(await verifyAuthorizationHeader(undefined, body, async () => pub, now)).toEqual({ ok: false, reason: "malformed" });
  });
});

describe("registry key lookup", () => {
  const T = Date.parse("2026-10-16T00:00:00Z");
  const participant = (over: Partial<Participant> = {}): Participant => ({
    subscriber_id: "seller.example.com",
    ukId: "uk-9",
    status: "SUBSCRIBED",
    type: "BPP",
    domain: "ONDC:RET11",
    subscriber_url: "https://seller.example.com/ondc",
    signing_public_key: "PUBKEY",
    encr_public_key: "ENCKEY",
    valid_from: "2026-01-01T00:00:00Z",
    valid_until: "2027-01-01T00:00:00Z",
    ...over,
  });
  const client = (reply: () => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>) => {
    let calls = 0;
    const c = createRegistryClient({
      registryUrl: "https://registry.test/v2.0/lookup",
      identity: identity().id,
      now: () => T,
      fetch: async () => {
        calls++;
        return reply();
      },
    });
    return { c, calls: () => calls };
  };
  const ok = (list: Participant[]) => async () => ({ ok: true, status: 200, json: async () => list });

  it("returns the key of a subscribed participant, and caches it", async () => {
    const { c, calls } = client(ok([participant()]));
    expect(await c.publicKeyFor("seller.example.com", "uk-9")).toBe("PUBKEY");
    expect(await c.publicKeyFor("seller.example.com", "uk-9")).toBe("PUBKEY");
    expect(calls()).toBe(1);
  });

  it("has no key for a participant that is not subscribed or is outside its validity", async () => {
    expect(await client(ok([participant({ status: "UNSUBSCRIBED" })])).c.publicKeyFor("seller.example.com", "uk-9")).toBeNull();
    expect(await client(ok([participant({ valid_until: "2026-06-01T00:00:00Z" })])).c.publicKeyFor("seller.example.com", "uk-9")).toBeNull();
    expect(await client(ok([participant({ ukId: "uk-other" })])).c.publicKeyFor("seller.example.com", "uk-9")).toBeNull();
  });

  it("fails closed when the registry is unreachable, and asks again next time", async () => {
    let up = false;
    const { c, calls } = client(async () =>
      up ? { ok: true, status: 200, json: async () => [participant()] } : { ok: false, status: 503, json: async () => ({}) },
    );
    expect(await c.publicKeyFor("seller.example.com", "uk-9")).toBeNull();
    up = true;
    expect(await c.publicKeyFor("seller.example.com", "uk-9")).toBe("PUBKEY");
    expect(calls()).toBe(2);
  });
});
