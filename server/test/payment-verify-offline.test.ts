import { afterEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.CASHFREE_APP_ID = "test-app";
});

import { authedAgent } from "./helpers.js";
import { prisma } from "../src/lib/prisma.js";

// Checking a payment while Cashfree cannot be reached.
//
// The pay screen asks whether the payment went through each time a customer
// returns to it. With the gateway unreachable (found by running the whole
// journey with every outside host blocked) that answered 500, so a customer
// who may just have paid was shown a server error. The payment is unknown,
// not failed: the order stays as it is, the answer says the gateway could not
// be reached, and the webhook settles it when Cashfree is back.

afterEach(() => vi.unstubAllGlobals());

describe("verifying a payment with the gateway unreachable", () => {
  it("answers with the order as it stands instead of an error", async () => {
    const { agent } = await authedAgent();
    const created = await agent
      .post("/api/orders")
      .send({ domain: "food", dishId: "dum-biryani", platform: "ondc" })
      .expect(201);
    const orderId = created.body.order.id as string;

    const real = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("cashfree.com")) throw new TypeError("fetch failed");
      return real(input, init);
    }));

    const res = await agent.post("/api/payments/verify").send({ orderId });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ orderStatus: "pending_payment", gatewayStatus: "UNREACHABLE" });

    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe("pending_payment");
  });
});
