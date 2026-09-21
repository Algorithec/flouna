import { prisma } from "../../lib/prisma.js";
import { blendRating, type CommunityRating } from "./blend.js";

export { blendRating, qualityOf, type CommunityRating } from "./blend.js";

// Community ratings. A rating only means something once a few people have left
// one, so a dish's shown rating is a blend of the catalog baseline and real
// user stars, weighted by how many ratings exist. That way one angry 1-star
// can't tank a dish, but a genuinely bad item drifts down over time.

export async function communityRatings(
  domain: "food" | "ride",
  itemKeys: string[],
): Promise<Map<string, CommunityRating>> {
  if (itemKeys.length === 0) return new Map();
  const rows = await prisma.orderRating.groupBy({
    by: ["itemKey"],
    where: { domain, itemKey: { in: itemKeys } },
    _avg: { stars: true },
    _count: { stars: true },
  });
  const map = new Map<string, CommunityRating>();
  for (const r of rows) {
    map.set(r.itemKey, {
      average: r._avg.stars ?? 0,
      count: r._count.stars,
    });
  }
  return map;
}

// Applies community ratings to anything carrying { rating } or { driverRating } plus an id field.
export async function withCommunityRatings<
  T extends Record<string, any>,
>(
  domain: "food" | "ride",
  items: T[],
  keyOf: (item: T) => string,
): Promise<T[]> {
  if (items.length === 0) return items;
  const ratings = await communityRatings(domain, items.map(keyOf));
  if (ratings.size === 0) return items;
  return items.map((item) => {
    const community = ratings.get(keyOf(item));
    // No community ratings for this option: say so with a zero rather than
    // leaving the count absent. The ranker treats an absent count as "this
    // source cannot tell us" and switches confidence weighting off for the
    // whole set, so a silent gap here would quietly disable it.
    if (!community) return { ...item, ratingCount: 0 };
    if ("rating" in item && typeof item.rating === "number") {
      return {
        ...item,
        rating: blendRating(item.rating, community),
        ratingCount: community.count,
      };
    }
    if ("driverRating" in item && typeof item.driverRating === "number") {
      return {
        ...item,
        driverRating: blendRating(item.driverRating, community),
        ratingCount: community.count,
      };
    }
    return { ...item, ratingCount: community.count };
  });
}
