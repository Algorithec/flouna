import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { CONTENDED_TX, withTxRetry } from "../../lib/txRetry.js";
import { ApiError } from "../../middleware/error.js";

// Promo codes. The client only ever sends a code string — every rupee of
// discount is computed here from the coupon's own rules, so a tampered client
// can't invent a discount (same principle as order pricing).

export type CouponCheck =
  | { ok: true; couponId: string; code: string; description: string; discountPaise: number }
  | { ok: false; reason: string };

export function normaliseCode(code: string): string {
  return code.trim().toUpperCase();
}

// `subtotalPaise` is what the discount applies to (items before fees).
export async function evaluateCoupon(opts: {
  code: string;
  userId: string;
  domain: "food" | "ride" | "shop";
  subtotalPaise: number;
}): Promise<CouponCheck> {
  const code = normaliseCode(opts.code);
  const coupon = await prisma.coupon.findUnique({ where: { code } });

  if (!coupon || !coupon.active) {
    return { ok: false, reason: "That code isn't valid" };
  }
  if (coupon.expiresAt && coupon.expiresAt.getTime() < Date.now()) {
    return { ok: false, reason: "This code has expired" };
  }
  if (coupon.domain !== "any" && coupon.domain !== opts.domain) {
    return {
      ok: false,
      reason:
        coupon.domain === "food"
          ? "This code works on food orders only"
          : coupon.domain === "ride"
          ? "This code works on rides only"
          : "This code isn't valid for this domain",
    };
  }
  if (opts.subtotalPaise < coupon.minOrderPaise) {
    return {
      ok: false,
      reason: `Spend at least ₹${Math.ceil(coupon.minOrderPaise / 100)} to use this code`,
    };
  }
  if (coupon.usageLimit !== null && coupon.usedCount >= coupon.usageLimit) {
    return { ok: false, reason: "This code has been fully claimed" };
  }

  // One redemption per user, per code.
  const already = await prisma.couponRedemption.findFirst({
    where: { couponId: coupon.id, userId: opts.userId },
  });
  if (already) return { ok: false, reason: "You've already used this code" };

  if (coupon.firstOrderOnly) {
    const paidBefore = await prisma.order.count({
      where: {
        userId: opts.userId,
        status: { in: ["confirmed", "in_progress", "completed"] },
      },
    });
    if (paidBefore > 0) {
      return { ok: false, reason: "This code is for your first order only" };
    }
  }

  // ---- discount, integer paise, never more than the subtotal ----
  let discount = 0;
  if (coupon.kind === "percent" && coupon.percentOff) {
    discount = Math.floor((opts.subtotalPaise * coupon.percentOff) / 100);
    if (coupon.maxDiscountPaise !== null) {
      discount = Math.min(discount, coupon.maxDiscountPaise);
    }
  } else if (coupon.kind === "flat" && coupon.valuePaise) {
    discount = coupon.valuePaise;
  }
  discount = Math.max(0, Math.min(discount, opts.subtotalPaise));

  if (discount === 0) return { ok: false, reason: "That code isn't valid" };

  return {
    ok: true,
    couponId: coupon.id,
    code: coupon.code,
    description: coupon.description,
    discountPaise: discount,
  };
}

// Called inside the order-creation transaction once the order exists.
/**
 * Creates an order and claims its promo code in one step, or neither.
 *
 * Both limits on a code used to be checked before the order existed and
 * recorded after it, with nothing tying the two together. Two orders placed at
 * the same moment both passed both checks: one customer used a
 * once-per-customer code twice, and a code capped at one use was claimed three
 * times. A double tap on a slow phone was enough.
 *
 * So the claim happens inside the order's own transaction, cap first. The cap
 * is a conditional increment the database applies atomically, so it cannot be
 * overtaken; it also takes the write lock on the code before the per-customer
 * check reads anything, so that check sees any claim committed ahead of it.
 * Serializable, so Postgres refuses a commit that raced another, and that
 * refusal is retried. A refused code creates no order at all: an order must
 * never exist with a discount its code did not grant.
 *
 * With no code there is nothing to claim, and the order is created exactly as
 * it always was.
 */
export async function createOrderClaimingCoupon<T extends { id: string }>(
  claim: { couponId: string; userId: string; discountPaise: number } | null,
  create: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  if (!claim) return create(prisma);

  return withTxRetry(() =>
    prisma.$transaction(
      async (tx) => {
        const claimed = await tx.$executeRaw`
          UPDATE "Coupon" SET "usedCount" = "usedCount" + 1
          WHERE "id" = ${claim.couponId}
            AND ("usageLimit" IS NULL OR "usedCount" < "usageLimit")`;
        if (claimed === 0) throw new ApiError(400, "This code has been fully claimed");

        const already = await tx.couponRedemption.findFirst({
          where: { couponId: claim.couponId, userId: claim.userId },
          select: { id: true },
        });
        if (already) throw new ApiError(400, "You've already used this code");

        const order = await create(tx);
        await tx.couponRedemption.create({
          data: {
            couponId: claim.couponId,
            userId: claim.userId,
            orderId: order.id,
            discountPaise: claim.discountPaise,
          },
        });
        return order;
      },
      // Nothing is committed when the database refuses or times out a
      // claim, so withTxRetry runs the whole thing again.
      CONTENDED_TX,
    ),
  );
}

// Codes worth showing on the checkout screen — active, unexpired, not
// exhausted. Users shouldn't have to guess what exists.
export async function listOfferedCoupons(domain: "food" | "ride") {
  const now = new Date();
  const coupons = await prisma.coupon.findMany({
    where: {
      active: true,
      domain: { in: [domain, "any"] },
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
    orderBy: { minOrderPaise: "asc" },
    take: 6,
  });
  return coupons
    .filter((c) => c.usageLimit === null || c.usedCount < c.usageLimit)
    .map((c) => ({
      code: c.code,
      description: c.description,
      minOrderPaise: c.minOrderPaise,
    }));
}
