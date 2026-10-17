import { prisma } from "../../lib/prisma.js";
import { ApiError } from "../../middleware/error.js";
import { quotesForDish } from "../food/food.service.js";

// The cart, on the server.
//
// One per customer, shared by every surface: the app's buttons and chat's
// "add it to my cart" call the same functions here, so they cannot disagree
// about what is in it. Lines hold only what was chosen; everything shown is
// read from the catalogue at the moment it is asked for, and checkout prices
// the cart afresh regardless.

/** Most of any one dish a single order may hold, as the app has always capped it. */
export const MAX_QTY = 20;
/** Distinct lines in one cart. Generous for a meal, and a bound on what one request can grow. */
export const MAX_LINES = 30;

export type CartView = {
  lines: {
    dishId: string;
    platform: string;
    qty: number;
    decisionId?: string;
    addedVia: string;
    name: string;
    restaurant: string;
    image?: string;
    /** Unit base price today, before offers. Checkout reprices. */
    pricePaise: number;
    available: boolean;
  }[];
  count: number;
  /**
   * Lines dropped just now because their dish or listing left the catalogue.
   * Kept, they would make every price check and checkout of the whole cart
   * fail; the app says how many went so the customer is not left wondering.
   */
  removed: number;
};

function listing(dishId: string, platform: string) {
  return quotesForDish(dishId).find((q) => q.platform === platform) ?? null;
}

async function cartId(userId: string): Promise<string> {
  // The first two requests from a new customer can race to create the cart
  // the same way; the loser reads the winner's.
  try {
    return (await prisma.cart.upsert({ where: { userId }, create: { userId }, update: {}, select: { id: true } })).id;
  } catch (err) {
    if ((err as { code?: string }).code !== "P2002") throw err;
    return (await prisma.cart.findUniqueOrThrow({ where: { userId }, select: { id: true } })).id;
  }
}

export async function getCart(userId: string): Promise<CartView> {
  const cart = await prisma.cart.findUnique({
    where: { userId },
    include: { items: { orderBy: { createdAt: "asc" } } },
  });
  const gone = (cart?.items ?? []).filter((i) => !listing(i.dishId, i.platform));
  if (gone.length) await prisma.cartItem.deleteMany({ where: { id: { in: gone.map((i) => i.id) } } });
  const kept = (cart?.items ?? []).filter((i) => !gone.includes(i));
  const lines = kept.map((i) => {
    const q = listing(i.dishId, i.platform);
    return {
      dishId: i.dishId,
      platform: i.platform,
      qty: i.qty,
      ...(i.decisionId ? { decisionId: i.decisionId } : {}),
      addedVia: i.addedVia,
      name: q?.name ?? "No longer available",
      restaurant: q?.restaurant ?? "",
      ...(q?.image ? { image: q.image } : {}),
      pricePaise: q?.basePaise ?? 0,
      available: Boolean(q),
    };
  });
  return { lines, count: lines.reduce((s, l) => s + l.qty, 0), removed: gone.length };
}

/**
 * Adds a dish, or more of one already there. Refuses a dish or listing that is
 * not in the catalogue, so nothing can be put in a cart that checkout would
 * then reject.
 */
export async function addItem(
  userId: string,
  item: { dishId: string; platform: string; qty?: number; decisionId?: string; via?: "app" | "chat" },
): Promise<CartView> {
  const qty = item.qty ?? 1;
  if (!Number.isSafeInteger(qty) || qty < 1 || qty > MAX_QTY) throw new ApiError(400, `Quantity must be 1 to ${MAX_QTY}`);
  if (!listing(item.dishId, item.platform)) throw new ApiError(404, "That dish is not available on that platform");
  const id = await cartId(userId);

  const where = { cartId_dishId_platform: { cartId: id, dishId: item.dishId, platform: item.platform } };
  const write = async () => {
    const existing = await prisma.cartItem.findUnique({ where });
    if (existing) {
      // Atomic increment avoids the lost-update under READ COMMITTED where
      // two taps both read the same qty and both write qty+1.
      await prisma.cartItem.update({ where: { id: existing.id }, data: { qty: { increment: qty }, ...(item.decisionId ? { decisionId: item.decisionId } : {}) } });
      // Clamp to MAX_QTY in a second write guarded by the condition, so
      // concurrent adds cannot push past the cap.
      await prisma.cartItem.updateMany({ where: { id: existing.id, qty: { gt: MAX_QTY } }, data: { qty: MAX_QTY } });
      return;
    }
    if ((await prisma.cartItem.count({ where: { cartId: id } })) >= MAX_LINES) {
      throw new ApiError(400, `A cart holds at most ${MAX_LINES} different dishes`);
    }
    await prisma.cartItem.create({
      data: { cartId: id, dishId: item.dishId, platform: item.platform, qty, decisionId: item.decisionId, addedVia: item.via ?? "app" },
    });
  };
  try {
    await write();
  } catch (err) {
    const code = (err as { code?: string }).code;
    // P2002: unique constraint (two creates raced), P2034: serialization
    // failure, SQLITE_BUSY: SQLite write contention.
    if (code !== "P2002" && code !== "P2034" && !String(err).includes("SQLITE_BUSY")) throw err;
    await write();
  }
  return getCart(userId);
}

/** Sets a line's quantity; zero removes it. */
export async function setQty(userId: string, item: { dishId: string; platform: string; qty: number }): Promise<CartView> {
  if (!Number.isSafeInteger(item.qty) || item.qty < 0 || item.qty > MAX_QTY) {
    throw new ApiError(400, `Quantity must be 0 to ${MAX_QTY}`);
  }
  const cart = await prisma.cart.findUnique({ where: { userId }, select: { id: true } });
  if (!cart) throw new ApiError(404, "That dish is not in your cart");
  const where = { cartId_dishId_platform: { cartId: cart.id, dishId: item.dishId, platform: item.platform } };
  const existing = await prisma.cartItem.findUnique({ where, select: { id: true } });
  if (!existing) throw new ApiError(404, "That dish is not in your cart");
  if (item.qty === 0) await prisma.cartItem.delete({ where: { id: existing.id } });
  else await prisma.cartItem.update({ where: { id: existing.id }, data: { qty: item.qty } });
  return getCart(userId);
}

export async function removeItem(userId: string, item: { dishId: string; platform: string }): Promise<CartView> {
  const cart = await prisma.cart.findUnique({ where: { userId }, select: { id: true } });
  if (cart) await prisma.cartItem.deleteMany({ where: { cartId: cart.id, dishId: item.dishId, platform: item.platform } });
  return getCart(userId);
}

export async function clearCart(userId: string): Promise<CartView> {
  const cart = await prisma.cart.findUnique({ where: { userId }, select: { id: true } });
  if (cart) await prisma.cartItem.deleteMany({ where: { cartId: cart.id } });
  return getCart(userId);
}

/**
 * Brings a cart saved in the browser by an older version of the app onto the
 * server, once. Takes the larger quantity where a dish is in both, so running
 * it twice changes nothing, and skips lines the catalogue no longer has.
 */
export async function importLocalCart(
  userId: string,
  lines: { dishId: string; platform: string; qty: number; decisionId?: string }[],
): Promise<CartView> {
  const id = await cartId(userId);
  for (const l of lines.slice(0, MAX_LINES)) {
    if (!listing(l.dishId, l.platform) || !Number.isSafeInteger(l.qty) || l.qty < 1) continue;
    const qty = Math.min(MAX_QTY, l.qty);
    const where = { cartId_dishId_platform: { cartId: id, dishId: l.dishId, platform: l.platform } };
    const existing = await prisma.cartItem.findUnique({ where });
    if (existing) {
      if (qty > existing.qty) await prisma.cartItem.update({ where: { id: existing.id }, data: { qty } });
    } else if ((await prisma.cartItem.count({ where: { cartId: id } })) < MAX_LINES) {
      await prisma.cartItem.create({ data: { cartId: id, dishId: l.dishId, platform: l.platform, qty, decisionId: l.decisionId } });
    }
  }
  return getCart(userId);
}
