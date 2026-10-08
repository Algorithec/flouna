import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { requireAuth } from "../../middleware/auth.js";
import { validateBody } from "../../middleware/validate.js";
import { env } from "../../config/env.js";
import { pushConfigured } from "./push.service.js";

export const notificationsRouter = Router();

// Public: lets the browser know whether push is available and which key to use.
notificationsRouter.get("/vapid", (_req, res) => {
  res.json({
    enabled: pushConfigured,
    publicKey: pushConfigured ? env.VAPID_PUBLIC_KEY : null,
  });
});

notificationsRouter.use(requireAuth);

// L1: only accept push endpoints from known browser push services, so a
// stored endpoint can never point the server at an arbitrary host.
const ALLOWED_PUSH_HOSTS = [
  /\.googleapis\.com$/, // Chrome / Android (FCM)
  /\.mozilla\.com$/, // Firefox (autopush)
  /\.push\.apple\.com$/, // Safari / iOS
  /\.windows\.com$/, // Edge (WNS)
  /\.microsoft\.com$/,
];

const subscriptionBody = z.object({
  endpoint: z
    .string()
    .url()
    .max(1000)
    .refine((url) => {
      try {
        const host = new URL(url).hostname;
        return ALLOWED_PUSH_HOSTS.some((re) => re.test(host));
      } catch {
        return false;
      }
    }, "Unsupported push endpoint"),
  keys: z.object({
    p256dh: z.string().max(255),
    auth: z.string().max(255),
  }),
});

notificationsRouter.post(
  "/subscribe",
  validateBody(subscriptionBody),
  async (req, res, next) => {
    try {
      const { endpoint, keys } = req.body as z.infer<typeof subscriptionBody>;
      // Upsert by endpoint so re-subscribing or switching accounts is clean.
      await prisma.pushSubscription.upsert({
        where: { endpoint },
        create: {
          userId: req.userId!,
          endpoint,
          p256dh: keys.p256dh,
          auth: keys.auth,
          vapidKey: env.VAPID_PUBLIC_KEY ?? null,
        },
        update: {
          userId: req.userId!,
          p256dh: keys.p256dh,
          auth: keys.auth,
          vapidKey: env.VAPID_PUBLIC_KEY ?? null,
        },
      });
      res.status(201).json({ ok: true });
    } catch (err) {
      next(err);
    }
  },
);

notificationsRouter.post(
  "/unsubscribe",
  validateBody(z.object({ endpoint: z.string().url().max(1000) }).strict()),
  async (req, res, next) => {
    try {
      const { endpoint } = req.body as { endpoint: string };
      await prisma.pushSubscription.deleteMany({
        where: { endpoint, userId: req.userId! },
      });
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  },
);
