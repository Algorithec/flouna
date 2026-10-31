import crypto from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { env } from "../src/config/env.js";
import { prisma } from "../src/lib/prisma.js";
import { NetworkIgmAdapter } from "../src/modules/complaints/igm.network.js";
import { ondcIdentity } from "../src/modules/ondc/identity.js";
import { authedAgent } from "./helpers.js";

// ONDC registered ondc.flouna.com with a different key pair for each domain:
// one for ONDC:RET11 and another for ONDC:TRV10. A ride message signed with
// the food key names a key id the TRV10 entry does not have, and a seller app
// looking the signer up by domain refuses it. Each message is signed with the
// key of its own domain.

type KeyEnv = {
  ONDC_SUBSCRIBER_ID?: string;
  ONDC_UNIQUE_KEY_ID?: string;
  ONDC_SIGNING_PRIVATE_KEY?: string;
  ONDC_UNIQUE_KEY_ID_TRV10?: string;
  ONDC_SIGNING_PRIVATE_KEY_TRV10?: string;
};
const e = env as KeyEnv;
const saved: KeyEnv = { ...e };
afterEach(() => Object.assign(e, saved));

function keys(withRide: boolean) {
  Object.assign(e, {
    ONDC_SUBSCRIBER_ID: "ondc.flouna.com",
    ONDC_UNIQUE_KEY_ID: "food-key-id",
    ONDC_SIGNING_PRIVATE_KEY: "food-private",
    ONDC_UNIQUE_KEY_ID_TRV10: withRide ? "ride-key-id" : undefined,
    ONDC_SIGNING_PRIVATE_KEY_TRV10: withRide ? "ride-private" : undefined,
  });
}

describe("ONDC signing identity per domain", () => {
  it("signs rides with the ride key pair and everything else with the default", () => {
    keys(true);
    expect(ondcIdentity("ONDC:TRV10")).toEqual({ subscriberId: "ondc.flouna.com", uniqueKeyId: "ride-key-id", signingPrivateKey: "ride-private" });
    expect(ondcIdentity("ONDC:RET11")?.uniqueKeyId).toBe("food-key-id");
    // Settlement and registry lookups name no domain.
    expect(ondcIdentity()?.uniqueKeyId).toBe("food-key-id");
  });

  it("falls back to the default pair for rides until the ride pair is set", () => {
    keys(false);
    expect(ondcIdentity("ONDC:TRV10")?.uniqueKeyId).toBe("food-key-id");
  });

  it("signs nothing without a subscriber id", () => {
    keys(true);
    e.ONDC_SUBSCRIBER_ID = undefined;
    expect(ondcIdentity("ONDC:TRV10")).toBeNull();
    expect(ondcIdentity("ONDC:RET11")).toBeNull();
  });

  it("asks for the key of the order's own domain when a complaint goes to the network", async () => {
    const asked: string[] = [];
    const key = crypto.generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "der" }).subarray(-32).toString("base64");
    const adapter = new NetworkIgmAdapter({
      identity: (domain) => {
        asked.push(domain);
        return { subscriberId: "ondc.flouna.com", uniqueKeyId: `${domain}-key`, signingPrivateKey: key };
      },
      send: async () => ({ ack: true, status: 200 }),
    });
    const signedUp = await authedAgent();
    const user = await prisma.user.update({
      where: { email: signedUp.email },
      data: { phone: `9${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}` },
    });
    const seller = { bppId: "seller.example", bppUri: "https://seller.example/ondc" };

    const ride = await prisma.ondcRide.create({
      data: {
        userId: user.id, txnId: crypto.randomUUID(), status: "completed", city: "std:080", pickup: "{}", drop: "{}",
        ...seller, providerId: "P1", itemId: "I1", fulfillmentId: "F1", sellerOrderId: "RIDE-ORDER-7",
      },
    });
    const rideComplaint = await signedUp.agent
      .post("/api/complaints")
      .send({ orderId: ride.id, category: "ORDER", subCategory: "DRIVER_CONDUCT", description: "Driver was rude" })
      .expect(201);
    expect(await adapter.sendIssue(rideComplaint.body.complaint.id)).toEqual({ sent: true });

    const food = await prisma.ondcOrder.create({
      data: {
        userId: user.id, txnId: crypto.randomUUID(), status: "placed", ...seller, providerId: "P1", locationId: "L1",
        storeName: "Test Store", city: "std:080", lines: JSON.stringify([{ itemId: "I1", count: 1 }]), fulfillmentId: "F1",
        sellerOrderId: "FOOD-ORDER-7", sellerState: "Accepted",
      },
    });
    const foodComplaint = await signedUp.agent
      .post("/api/complaints")
      .send({ orderId: food.id, category: "ORDER", subCategory: "WRONG_ITEM_DELIVERED", description: "Wrong dish" })
      .expect(201);
    expect(await adapter.sendIssue(foodComplaint.body.complaint.id)).toEqual({ sent: true });

    expect(asked).toEqual(["ONDC:TRV10", "ONDC:RET11"]);
  });
});
