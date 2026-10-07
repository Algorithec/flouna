import webpush from "web-push";
import { env } from "../../config/env.js";
import { prisma } from "../../lib/prisma.js";

// web-push validates the key material and THROWS at module load, so a
// mistyped or truncated VAPID key takes the entire API down before it can
// serve a request — with an error from the library rather than anything that
// names the cause. Push is a nice-to-have; the API is not. Degrade instead.
function initPush(): boolean {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return false;
  try {
    webpush.setVapidDetails(
      env.VAPID_SUBJECT,
      env.VAPID_PUBLIC_KEY,
      env.VAPID_PRIVATE_KEY,
    );
    return true;
  } catch (err) {
    console.error(
      "[push] VAPID keys are set but invalid, push notifications are disabled. " +
        "Regenerate with `npx web-push generate-vapid-keys`. " +
        (err instanceof Error ? err.message : String(err)),
    );
    return false;
  }
}

export const pushConfigured = initPush();

/**
 * Subscriptions made with a key other than the current one cannot receive
 * anything: the push service refuses them with a 403 the cleanup below did
 * not recognise, so they used to stay forever and fail on every send. They
 * are removed here instead. Rows with no recorded key are kept and tried.
 */
async function dropStale<T extends { id: string; vapidKey: string | null }>(subs: T[]): Promise<{ live: T[]; stale: number }> {
  const stale = subs.filter((s) => s.vapidKey !== null && s.vapidKey !== env.VAPID_PUBLIC_KEY);
  if (stale.length) {
    await prisma.pushSubscription
      .deleteMany({ where: { id: { in: stale.map((s) => s.id) } } })
      .catch(() => {});
  }
  return { live: subs.filter((s) => !stale.includes(s)), stale: stale.length };
}

export type PushPayload = {
  title: string;
  body: string;
  url?: string;
};

// Broadcast to EVERY registered device across all users (super-admin
// announcements). Returns honest delivery counts; {configured:false} when VAPID
// keys are absent rather than pretending anything was sent. Dead subscriptions
// are pruned as they're discovered, same as the per-user path.
export async function sendPushToAll(
  payload: PushPayload,
): Promise<{ configured: boolean; sent: number; failed: number; devices: number }> {
  if (!pushConfigured) return { configured: false, sent: 0, failed: 0, devices: 0 };

  const all = await prisma.pushSubscription.findMany();
  const { live: subs, stale } = await dropStale(all);
  const body = JSON.stringify(payload);
  let sent = 0;
  let failed = stale;
  // Send in bounded batches rather than one unbounded Promise.all — keeps
  // sockets/memory flat and stays under push-provider rate limits as the
  // subscriber list grows.
  const BATCH = 100;
  for (let i = 0; i < subs.length; i += BATCH) {
    await Promise.all(
      subs.slice(i, i + BATCH).map(async (sub) => {
        try {
          await webpush.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            body,
          );
          sent += 1;
        } catch (err) {
          failed += 1;
          const statusCode = (err as { statusCode?: number }).statusCode;
          if (statusCode === 404 || statusCode === 410) {
            await prisma.pushSubscription.delete({ where: { id: sub.id } }).catch(() => {});
          }
        }
      }),
    );
  }
  return { configured: true, sent, failed, devices: all.length };
}

// Sends a notification to every device a user has registered. Dead
// subscriptions (410/404) are pruned automatically.
export async function sendPushToUser(userId: string, payload: PushPayload) {
  if (!pushConfigured) return;

  const { live: subs } = await dropStale(
    await prisma.pushSubscription.findMany({ where: { userId } }),
  );
  if (subs.length === 0) return;

  const body = JSON.stringify(payload);
  await Promise.all(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification(
          {
            endpoint: sub.endpoint,
            keys: { p256dh: sub.p256dh, auth: sub.auth },
          },
          body,
        );
      } catch (err) {
        const statusCode = (err as { statusCode?: number }).statusCode;
        if (statusCode === 404 || statusCode === 410) {
          // Subscription expired or was revoked — remove it.
          await prisma.pushSubscription
            .delete({ where: { id: sub.id } })
            .catch(() => {});
        } else {
          console.error("[push] send failed:", statusCode ?? err);
        }
      }
    }),
  );
}
