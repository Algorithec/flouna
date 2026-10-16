import crypto from "node:crypto";
import { env } from "../../config/env.js";
import { prisma } from "../../lib/prisma.js";
import { ApiError } from "../../middleware/error.js";
import { commercialTerms } from "./commercial.js";
import { distanceKm, parseOnSearch, type OndcOffer } from "./catalog.js";
import { buildSearch } from "./retail.js";
import type { SigningIdentity } from "./signing.js";
import { GATEWAY_URL, sendSigned, type SendResult } from "./transport.js";

// Searching the ONDC network for food.
//
// One search goes to the gateway, which passes it to every food seller app on
// the network; each answers over the next seconds with its own stores and
// menus, as on_search callbacks recorded by the callbacks router. Results are
// read back from those, so a slow seller app simply shows up a little later.

/** How long seller apps are given to answer, as the search's own ttl says. */
export const SEARCH_WINDOW_MS = 30_000;

/**
 * Official STD codes, which is how ONDC names cities. Only cities listed here
 * can be searched; anywhere else is told so rather than searched under the
 * wrong city.
 */
const STD_CODE: Record<string, string> = {
  bengaluru: "std:080",
  bangalore: "std:080",
  hyderabad: "std:040",
  secunderabad: "std:040",
  delhi: "std:011",
  "new delhi": "std:011",
  mumbai: "std:022",
  chennai: "std:044",
  kolkata: "std:033",
  pune: "std:020",
  ahmedabad: "std:079",
  jaipur: "std:0141",
  lucknow: "std:0522",
  chandigarh: "std:0172",
  kochi: "std:0484",
  coimbatore: "std:0422",
  noida: "std:0120",
  gurugram: "std:0124",
  gurgaon: "std:0124",
  visakhapatnam: "std:0891",
  vijayawada: "std:0866",
  indore: "std:0731",
  bhopal: "std:0755",
  nagpur: "std:0712",
  surat: "std:0261",
  mysuru: "std:0821",
  mysore: "std:0821",
  thiruvananthapuram: "std:0471",
};

export function stdCodeFor(city: string): string | null {
  const key = city.trim().toLowerCase().replace(/\s+(urban|rural|city|district)$/, "");
  return STD_CODE[key] ?? null;
}

type Send = (url: string, action: string, envelope: { context: Record<string, unknown>; message: unknown }, id: SigningIdentity) => Promise<SendResult>;

function identity(): SigningIdentity | null {
  return env.ONDC_SUBSCRIBER_ID && env.ONDC_UNIQUE_KEY_ID && env.ONDC_SIGNING_PRIVATE_KEY
    ? { subscriberId: env.ONDC_SUBSCRIBER_ID, uniqueKeyId: env.ONDC_UNIQUE_KEY_ID, signingPrivateKey: env.ONDC_SIGNING_PRIVATE_KEY }
    : null;
}

export type StartOutcome = { searchId: string } | { unavailable: string };

/**
 * Sends a search for `query` from the customer's default delivery address.
 * Never throws for something the customer can fix or the network refused: it
 * says why instead, so the rest of the answer still shows.
 */
export async function startOndcSearch(
  userId: string,
  query: string,
  opts: {
    send?: Send;
    identity?: () => SigningIdentity | null;
    /**
     * False returns as soon as the search is recorded and sends it in the
     * background, for chat, which should not wait on the network to answer.
     * Its status then shows whether the gateway took it.
     */
    wait?: boolean;
  } = {},
): Promise<StartOutcome> {
  const id = (opts.identity ?? identity)();
  if (!id) return { unavailable: "ONDC is not configured on this deployment" };
  const address = await prisma.address.findFirst({
    where: { userId, isDefault: true },
    select: { lat: true, lng: true, city: true, pincode: true },
  });
  if (!address) return { unavailable: "Add a delivery address to search ONDC sellers near you" };
  if (address.lat == null || address.lng == null) return { unavailable: "Your delivery address has no map location, so nearby ONDC sellers cannot be found" };
  const city = stdCodeFor(address.city);
  if (!city) return { unavailable: `ONDC search is not available for ${address.city} yet` };

  const searchId = crypto.randomUUID();
  const envelope = buildSearch({
    transactionId: searchId,
    city,
    finderFeePercent: commercialTerms().finderFeePercent,
    query: query.slice(0, 80),
    gps: `${address.lat.toFixed(6)},${address.lng.toFixed(6)}`,
    areaCode: address.pincode,
  });
  // Recorded before sending, so answers that arrive quickly have a search to
  // belong to.
  await prisma.ondcSearch.create({
    data: { id: searchId, userId, query: query.slice(0, 80), lat: address.lat, lng: address.lng, city, status: "sending" },
  });
  const send = async () => {
    const result = await (opts.send ?? ((u, a, e, i) => sendSigned(u, a, e, i)))(GATEWAY_URL[env.ONDC_REGISTRY_ENV], "search", envelope, id);
    await prisma.ondcSearch.update({ where: { id: searchId }, data: { status: result.ack ? "sent" : "refused" } });
    await prisma.ondcTransaction.create({
      data: {
        txnId: searchId,
        messageId: envelope.context.message_id as string,
        action: "search",
        domain: "ONDC:RET11",
        request: JSON.stringify(envelope),
        status: result.ack ? "ack" : "nack",
        signed: true,
        simulated: false,
      },
    });
    return result.ack;
  };
  if (opts.wait === false) {
    void send().catch((err: unknown) => console.error("[ondc] search send failed", err instanceof Error ? err.message : String(err)));
    return { searchId };
  }
  if (!(await send())) return { unavailable: "The ONDC network did not accept the search just now" };
  return { searchId };
}

export type SellerResult = OndcOffer & { distanceKm: number | null };

export type SearchResults = {
  searchId: string;
  query: string;
  /** "searching" while seller apps may still answer, then "complete". */
  status: "searching" | "complete" | "refused";
  /** Seller apps and stores that have answered so far. */
  sellerApps: number;
  stores: number;
  offers: SellerResult[];
};

/** Which offers match what was searched, weighting the rarer words more, as the catalogue search does. */
function matching(offers: OndcOffer[], query: string): OndcOffer[] {
  const terms = query.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3);
  if (terms.length === 0) return offers;
  const text = (o: OndcOffer) => `${o.name} ${o.description ?? ""}`.toLowerCase();
  const has = (o: OndcOffer, t: string) => text(o).includes(t) || text(o).includes(t.replace(/s$/, ""));
  const weight = new Map(terms.map((t) => [t, Math.log((offers.length + 1) / (offers.filter((o) => has(o, t)).length + 0.5))]));
  const score = (o: OndcOffer) => terms.reduce((s, t) => s + (has(o, t) ? Math.max(weight.get(t) ?? 0, 0.01) : 0), 0);
  const top = Math.max(0, ...offers.map(score));
  return top > 0 ? offers.filter((o) => score(o) >= top - 1e-9) : [];
}

/** Everything seller apps have answered so far, for the customer who searched. */
export async function ondcSearchResults(searchId: string, userId: string, now = new Date()): Promise<SearchResults> {
  const search = await prisma.ondcSearch.findUnique({ where: { id: searchId } });
  if (!search || search.userId !== userId) throw new ApiError(404, "Search not found");

  const answers = await prisma.ondcTransaction.findMany({
    where: { txnId: searchId, action: "on_search" },
    orderBy: { createdAt: "asc" },
    select: { response: true },
  });
  // Latest answer wins for each dish: a seller app may refresh its catalogue
  // within one search.
  const byKey = new Map<string, OndcOffer>();
  for (const a of answers) {
    let body: unknown;
    try {
      body = JSON.parse(a.response ?? "null");
    } catch {
      continue;
    }
    for (const o of parseOnSearch(body)) byKey.set(`${o.seller.bppId}|${o.seller.providerId}|${o.seller.locationId}|${o.itemId}`, o);
  }
  const from = { lat: search.lat, lng: search.lng };
  const offers = matching([...byKey.values()], search.query)
    .map((o) => ({ ...o, distanceKm: o.seller.gps ? Math.round(distanceKm(from, o.seller.gps) * 10) / 10 : null }))
    // A store that said it delivers within 15 km is not offered to someone
    // 1,700 km away, whatever the gateway passed along.
    .filter((o) => !(o.seller.delivers && "radiusKm" in o.seller.delivers && o.distanceKm !== null && o.distanceKm > o.seller.delivers.radiusKm))
    // Nearest first, then cheapest: a closer store is the faster delivery.
    .sort((a, b) => (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity) || a.pricePaise - b.pricePaise)
    .slice(0, 60);

  const status = search.status === "refused" ? "refused" : now.getTime() - search.createdAt.getTime() < SEARCH_WINDOW_MS ? "searching" : "complete";
  return {
    searchId,
    query: search.query,
    status,
    sellerApps: new Set(offers.map((o) => o.seller.bppId)).size,
    stores: new Set(offers.map((o) => `${o.seller.bppId}|${o.seller.providerId}`)).size,
    offers,
  };
}

/** How long a search, and the catalogues sellers answered it with, are kept. */
export const SEARCH_RETENTION_DAYS = 7;

/**
 * Housekeeping, run hourly. A search's results are read within seconds, yet
 * each seller's answer is its whole catalogue (megabytes) and each search
 * records where the customer was. The searches go, location and all; the
 * transaction log keeps a row for every answer, without the catalogue, so the
 * record of who answered stays for audit.
 */
export async function pruneOndcSearches(now = new Date(), days = SEARCH_RETENTION_DAYS) {
  const cutoff = new Date(now.getTime() - days * 86_400_000);
  const emptied = await prisma.ondcTransaction.updateMany({
    where: { action: "on_search", createdAt: { lt: cutoff }, response: { not: null } },
    data: { response: null },
  });
  const searches = await prisma.ondcSearch.deleteMany({ where: { createdAt: { lt: cutoff } } });
  return { catalogues: emptied.count, searches: searches.count };
}
