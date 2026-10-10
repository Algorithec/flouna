import { prisma } from "../../lib/prisma.js";
import { sendPushToUser } from "../notifications/push.service.js";
import { emitToUser } from "../../realtime/socket.js";
import { enqueueNotification } from "../notifications/outbox.service.js";

// The latest observed best price for an item, from the same PriceObservation
// data the timing advisor records on every quote. Returns null if unseen.
async function latestBestPaise(
  domain: string,
  itemKey: string,
): Promise<number | null> {
  const row = await prisma.priceObservation.findFirst({
    where: { domain, key: itemKey },
    orderBy: { createdAt: "desc" },
    select: { bestPaise: true },
  });
  return row?.bestPaise ?? null;
}

// Checks every active alert; for any whose item is now at/below its target,
// deactivates it and notifies the owner via push + realtime. Returns the count.
export async function checkPriceAlerts(): Promise<number> {
  const alerts = await prisma.priceAlert.findMany({
    where: { active: true },
    take: 500,
  });

  let triggered = 0;
  for (const alert of alerts) {
    const best = await latestBestPaise(alert.domain, alert.itemKey);
    if (best === null || best > alert.targetPaise) continue;

    // Claim the alert, then notify. The sweep runs on a timer that does not
    // wait for the previous run, and a pass over 500 alerts that each do a
    // read and a push can outlast its own minute — two overlapping passes both
    // read the alert as active and both pushed, so the customer was told about
    // the same price drop twice. Scoped to it still being active, only one
    // pass gets to announce it (and the same holds for a second instance).
    const claimed = await prisma.priceAlert.updateMany({
      where: { id: alert.id, active: true },
      data: { active: false, triggeredAt: new Date(), lastSeenPaise: best },
    });
    if (claimed.count === 0) continue;

    const rupees = Math.round(best / 100);
    void sendPushToUser(alert.userId, {
      title: `Price drop: ${alert.itemName} 🔻`,
      body: `Now ₹${rupees}, at or below your ₹${Math.round(alert.targetPaise / 100)} target.`,
      url: alert.domain === "food" ? "/food" : "/rides",
    });
    // Email is the second channel (money-updates gated). Dedupe per alert so a
    // re-triggered/re-armed alert can't double-mail for the same event. Awaited
    // (one insert) so the alert isn't marked done before the email is queued.
    await enqueueNotification(
      alert.userId,
      "money.price_drop",
      {
        item: alert.itemName,
        price: `₹${rupees}`,
        target: `₹${Math.round(alert.targetPaise / 100)}`,
        domain: alert.domain,
      },
      // One email per (alert, observed price) — a re-armed alert that fires at
      // a new price mails again; the same price never double-mails.
      { dedupeKey: `price_drop:${alert.id}:${best}` },
    ).catch(() => {});
    emitToUser(alert.userId, "price-alert", {
      alertId: alert.id,
      itemName: alert.itemName,
      domain: alert.domain,
      newPaise: best,
      targetPaise: alert.targetPaise,
    });
    triggered++;
  }
  return triggered;
}
