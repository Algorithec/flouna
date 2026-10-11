// Whose name a member of a cart is allowed to see.
//
// Split out of groups.routes.ts because the cart summary was not the only place
// that prints a member's name: the encrypted chat lists every member device
// beside its owner's name, and host checkout prints a name against every share.
// Those two read the User row directly, so a member who had set their profile
// to "nobody" appeared as "Flouna user" on the cart screen and under their real
// name one tap away in the chat. One function, used everywhere a name is shown,
// is the only arrangement in which the setting means anything.

import { prisma } from "../../lib/prisma.js";

/** A member is "active" if one of their sessions was used in this window. */
const ACTIVE_WINDOW_MS = 5 * 60 * 1000;

/** The stand-in shown instead of a name the viewer is not entitled to. */
export const HIDDEN_NAME = "Flouna user";

/**
 * Applies each member's own Privacy settings to what the viewer is shown.
 *
 * profileVisibility decides whether the viewer sees a real name at all:
 * "everyone" always does, "nobody" never does, and "contacts" does only if the
 * two have shared some other cart before. activityStatus decides whether the
 * viewer is told they're online. Neither setting ever hides you from yourself.
 */
export async function privacyView(
  viewerId: string,
  memberIds: string[],
  cartId: string,
) {
  if (memberIds.length === 0) {
    return {
      nameFor: (_id: string, name: string) => name,
      activeFor: () => false,
    };
  }

  const users = await prisma.user.findMany({
    where: { id: { in: memberIds } },
    select: { id: true, profileVisibility: true, activityStatus: true },
  });

  // Carts the viewer belongs to, so "contacts" can mean something concrete:
  // people they have actually shared an order with before this one.
  const viewerCarts = await prisma.groupCartMember.findMany({
    where: { userId: viewerId, NOT: { cartId } },
    select: { cartId: true },
  });
  const sharedIds = new Set<string>();
  if (viewerCarts.length > 0) {
    const shared = await prisma.groupCartMember.findMany({
      where: {
        cartId: { in: viewerCarts.map((c) => c.cartId) },
        userId: { in: memberIds },
      },
      select: { userId: true },
    });
    for (const s of shared) sharedIds.add(s.userId);
  }

  const since = new Date(Date.now() - ACTIVE_WINDOW_MS);
  const recent = await prisma.refreshToken.findMany({
    where: { userId: { in: memberIds }, revokedAt: null, lastUsedAt: { gte: since } },
    select: { userId: true },
  });
  const activeIds = new Set(recent.map((r) => r.userId));

  const settings = new Map(users.map((u) => [u.id, u]));

  return {
    nameFor(id: string, name: string) {
      if (id === viewerId) return name;
      const s = settings.get(id);
      if (!s || s.profileVisibility === "everyone") return name;
      if (s.profileVisibility === "contacts" && sharedIds.has(id)) return name;
      return HIDDEN_NAME;
    },
    activeFor(id: string) {
      if (id === viewerId) return true;
      const s = settings.get(id);
      if (!s?.activityStatus) return false;
      return activeIds.has(id);
    },
  };
}
