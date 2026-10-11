import { describe, expect, it } from "vitest";
import { authedAgent } from "./helpers.js";
import { prisma } from "../src/lib/prisma.js";
import { checkSavingsMilestone } from "../src/modules/notifications/outbox.service.js";

// "You've saved ₹500 with Flouna" is a claim about money, so it has to be the
// same money the Savings screen reports. The screen counts paid orders; the
// milestone counted every order row ever created, including the ones abandoned
// at the payment screen.
//
// So the email congratulated people on savings the app showed as zero — and
// because the milestone is deduped per threshold, the false crossing burned the
// key and the real one was never announced.

describe("the savings milestone follows paid orders", () => {
  it("does not fire on orders that were never paid for", async () => {
    const { agent, email } = await authedAgent();
    const user = await prisma.user.findUniqueOrThrow({
      where: { email },
      select: { id: true },
    });

    // An unpaid order carrying more than the first milestone's worth of
    // "savings": exactly what sitting on the payment screen leaves behind.
    const placed = await agent
      .post("/api/orders")
      .send({ domain: "food", dishId: "masala-dosa", platform: "ondc" })
      .expect(201);
    await prisma.order.update({
      where: { id: placed.body.order.id },
      data: { savedPaise: 90_000, status: "pending_payment" },
    });

    await checkSavingsMilestone(user.id);
    expect(
      await prisma.notification.count({
        where: { userId: user.id, type: "money.savings_milestone" },
      }),
    ).toBe(0);

    // What the customer is actually shown, for comparison.
    const shown = await agent.get("/api/users/savings").expect(200);
    expect(shown.body.totalSavedPaise).toBe(0);
  });

  it("still fires once the order is paid", async () => {
    const { agent, email } = await authedAgent();
    const user = await prisma.user.findUniqueOrThrow({
      where: { email },
      select: { id: true },
    });
    const placed = await agent
      .post("/api/orders")
      .send({ domain: "food", dishId: "masala-dosa", platform: "ondc" })
      .expect(201);
    await agent
      .post("/api/payments/simulate")
      .send({ orderId: placed.body.order.id, method: "upi" })
      .expect(200);
    await prisma.order.update({
      where: { id: placed.body.order.id },
      data: { savedPaise: 90_000 },
    });

    await checkSavingsMilestone(user.id);
    expect(
      await prisma.notification.count({
        where: { userId: user.id, type: "money.savings_milestone" },
      }),
    ).toBe(1);
  });
});
