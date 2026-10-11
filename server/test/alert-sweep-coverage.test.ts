import { describe, expect, it } from "vitest";
import { authedAgent } from "./helpers.js";
import { prisma } from "../src/lib/prisma.js";
import { checkPriceAlerts } from "../src/modules/alerts/alerts.service.js";

// The sweep read the first 500 active alerts and stopped. A customer can hold
// thirty, so seventeen keen customers were enough for the alerts past the cut
// to stop being looked at — armed on the screen, promising a notification that
// could never arrive.
//
// Written as the attack on the cut: put the alert that should fire on the far
// side of it.

describe("the price-alert sweep covers every armed alert", () => {
  it("triggers an alert sitting past the first batch", async () => {
    const { email } = await authedAgent({ withAddress: false });
    const user = await prisma.user.findUniqueOrThrow({
      where: { email },
      select: { id: true },
    });

    // Something to watch, and a price well above every target so the padding
    // alerts stay armed and keep filling the batch.
    await prisma.priceObservation.create({
      data: { domain: "food", key: "sweep-padding", hour: 12, weekday: 0, bestPaise: 900_000 },
    });
    await prisma.priceAlert.createMany({
      data: Array.from({ length: 520 }, (_, i) => ({
        userId: user.id,
        domain: "food",
        itemKey: "sweep-padding",
        itemName: `Padding ${i}`,
        targetPaise: 10_00,
        lastSeenPaise: 900_000,
      })),
    });

    // The one that should fire, created last so it sorts past the padding.
    await prisma.priceObservation.create({
      data: { domain: "food", key: "sweep-target", hour: 12, weekday: 0, bestPaise: 12_000 },
    });
    const watched = await prisma.priceAlert.create({
      data: {
        userId: user.id,
        domain: "food",
        itemKey: "sweep-target",
        itemName: "Watched dish",
        targetPaise: 20_000,
        lastSeenPaise: 25_000,
      },
    });
    const position = await prisma.priceAlert.count({
      where: { active: true, id: { lt: watched.id } },
    });
    expect(position).toBeGreaterThan(500);

    const fired = await checkPriceAlerts();
    expect(fired).toBeGreaterThan(0);

    const after = await prisma.priceAlert.findUniqueOrThrow({
      where: { id: watched.id },
      select: { active: true, triggeredAt: true, lastSeenPaise: true },
    });
    expect(after.active).toBe(false);
    expect(after.triggeredAt).not.toBeNull();
    expect(after.lastSeenPaise).toBe(12_000);
  });
});
