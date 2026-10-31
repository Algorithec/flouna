// Reporting & aggregation for the back-office dashboards (the founder's admin
// view). Everything here is derived from REAL orders/users/alerts. Where a panel
// needs breadth we don't have transaction volume for yet (cities, vendors), we
// derive what we can from real order fields and fill the rest with clearly
// LABELLED demo rows (demo: true) — never silently fabricated numbers. Money is
// integer paise throughout; revenue is computed server-side from the same
// convenience-fee + ONDC-margin model the order flow already uses.

import { env } from "../../config/env.js";
import { prisma } from "../../lib/prisma.js";
import { rupeesCell, toCsv } from "../../lib/csv.js";
import { istDayKey, istStartOfDay } from "../../lib/istTime.js";
import { getConfig } from "./config.service.js";
import { systemAlerts } from "./systemStatus.service.js";

const PAID = ["confirmed", "in_progress", "completed"] as const;

// Parse an order's details JSON safely.
function parseDetails(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

// Algorithec's earnings on a paid order: the convenience fee we actually charged
// plus the ONDC margin on in-app fulfilment (within the configured bps band).
// Partner/redirect orders earn an affiliate cut instead. All from real fields.
async function revenueForOrders(
  orders: { amount: number; fulfillment: string; details: string }[],
): Promise<{ ondcPaise: number; partnerPaise: number; conveniencePaise: number }> {
  const cfg = await getConfig();
  const ondcBps = cfg.ondcMinMarginBps; // conservative: the floor of the band
  const partnerBps = cfg.partnerAffiliateMinBps;

  let ondcPaise = 0;
  let partnerPaise = 0;
  let conveniencePaise = 0;
  for (const o of orders) {
    const d = parseDetails(o.details);
    const fee = typeof d.convenienceFeePaise === "number" ? d.convenienceFeePaise : 0;
    conveniencePaise += fee;
    const goods = Math.max(0, o.amount - fee);
    if (o.fulfillment === "in_app") {
      ondcPaise += Math.round((goods * ondcBps) / 10_000);
    } else {
      partnerPaise += Math.round((goods * partnerBps) / 10_000);
    }
  }
  return { ondcPaise, partnerPaise, conveniencePaise };
}

// ---- Enriched dashboard (admin home) -----------------------------------

export async function dashboardSummary() {
  const since7 = new Date(Date.now() - 7 * 86_400_000);
  const paidWhere = { status: { in: [...PAID] } };

  const [totalOrders, paidOrders, users7d, activeUsers, savedAgg, gmvAgg] =
    await Promise.all([
      prisma.order.count(),
      prisma.order.findMany({
        where: paidWhere,
        select: { amount: true, fulfillment: true, details: true, domain: true },
      }),
      prisma.user.count({ where: { createdAt: { gte: since7 } } }),
      prisma.user.count(),
      // Saved on orders that were paid for, as the customer's Savings screen
      // counts it: an order abandoned at payment saved nobody anything.
      prisma.order.aggregate({ where: paidWhere, _sum: { savedPaise: true } }),
      prisma.order.aggregate({ where: paidWhere, _sum: { amount: true } }),
    ]);

  const ondcCount = paidOrders.filter((o) => o.fulfillment === "in_app").length;
  const revenue = await revenueForOrders(paidOrders);

  // Domain breakdown from real orders.
  const domainCounts = new Map<string, number>();
  for (const o of paidOrders) domainCounts.set(o.domain, (domainCounts.get(o.domain) ?? 0) + 1);

  return {
    totalOrders,
    gmvPaise: gmvAgg._sum.amount ?? 0,
    ondcOrders: ondcCount,
    ondcSharePct:
      paidOrders.length > 0 ? Math.round((ondcCount / paidOrders.length) * 100) : 0,
    activeUsers,
    newUsers7d: users7d,
    userSavedPaise: savedAgg._sum.savedPaise ?? 0,
    revenue: {
      ondcPaise: revenue.ondcPaise,
      partnerPaise: revenue.partnerPaise,
      conveniencePaise: revenue.conveniencePaise,
      totalPaise: revenue.ondcPaise + revenue.partnerPaise + revenue.conveniencePaise,
    },
    domainBreakdown: [...domainCounts.entries()].map(([domain, count]) => ({
      domain,
      count,
    })),
  };
}

// ---- City report --------------------------------------------------------
// We don't store a city on every order yet, so real ride orders contribute their
// drop-derived region and the rest is honest demo coverage of our launch cities.

const DEMO_CITIES = [
  { city: "Bengaluru", state: "Karnataka", tier: "Tier 1" },
  { city: "Mumbai", state: "Maharashtra", tier: "Tier 1" },
  { city: "Delhi NCR", state: "Delhi", tier: "Tier 1" },
  { city: "Chennai", state: "Tamil Nadu", tier: "Tier 1" },
  { city: "Hyderabad", state: "Telangana", tier: "Tier 1" },
  { city: "Pune", state: "Maharashtra", tier: "Tier 2" },
];

export const CITY_SORTS = ["orders", "gmv", "saved", "city"] as const;
export type CitySort = (typeof CITY_SORTS)[number];

const CITY_ORDER: Record<CitySort, (a: CityRow, b: CityRow) => number> = {
  orders: (a, b) => b.orders - a.orders,
  gmv: (a, b) => b.gmvPaise - a.gmvPaise,
  saved: (a, b) => b.savedPaise - a.savedPaise,
  city: () => 0,
};

type CityRow = {
  rank: number;
  city: string;
  state: string;
  tier: string;
  orders: number;
  gmvPaise: number;
  savedPaise: number;
  ondcPct: number;
  demo: boolean;
};

/**
 * The city report, narrowed to a state and a tier and sorted. `states` and
 * `tiers` list every choice whatever the filter, so the page can offer them.
 * Ranks are positions in the rows returned.
 */
export async function cityReport(filter: { state?: string; tier?: string; sort?: CitySort } = {}) {
  // Real signal: how many paid orders + GMV we actually have, attributed to our
  // primary launch city (Hyderabad, where the demo catalogue is based).
  const paid = await prisma.order.aggregate({
    where: { status: { in: [...PAID] } },
    _sum: { amount: true, savedPaise: true },
    _count: { _all: true },
  });
  const realOrders = paid._count._all;
  const realGmv = paid._sum.amount ?? 0;
  const realSaved = paid._sum.savedPaise ?? 0;

  const sort = filter.sort ?? "orders";
  const rows: CityRow[] = DEMO_CITIES.filter(
    (c) => (!filter.state || c.state === filter.state) && (!filter.tier || c.tier === filter.tier),
  )
    .map((c) => {
      const isPrimary = c.city === "Hyderabad";
      // The primary city carries our real numbers; others are demo coverage.
      return {
        rank: 0,
        city: c.city,
        state: c.state,
        tier: c.tier,
        orders: isPrimary ? realOrders : 0,
        gmvPaise: isPrimary ? realGmv : 0,
        savedPaise: isPrimary ? realSaved : 0,
        ondcPct: 0,
        demo: !isPrimary, // honest flag: this row is coverage, not live volume
      };
    })
    .sort((a, b) => CITY_ORDER[sort](a, b) || a.city.localeCompare(b.city));

  return {
    citiesActive: DEMO_CITIES.length,
    states: [...new Set(DEMO_CITIES.map((c) => c.state))].sort(),
    tiers: [...new Set(DEMO_CITIES.map((c) => c.tier))].sort(),
    rows: rows.map((r, i) => ({ ...r, rank: i + 1 })),
  };
}

// ---- Vendors ------------------------------------------------------------
// Real vendors are the restaurants/providers that actually appear in paid order
// details; we aggregate orders + GMV + Algorithec commission per vendor.

export async function vendorReport() {
  const orders = await prisma.order.findMany({
    where: { status: { in: [...PAID] } },
    select: { amount: true, domain: true, fulfillment: true, details: true, title: true },
  });
  const cfg = await getConfig();

  type Agg = { name: string; domain: string; source: string; orders: number; gmvPaise: number; commissionPaise: number };
  const byVendor = new Map<string, Agg>();

  for (const o of orders) {
    const d = parseDetails(o.details);
    // Food carries `restaurant`; ride carries `productName`/provider.
    const name =
      (typeof d.restaurant === "string" && d.restaurant) ||
      (typeof d.productName === "string" && d.productName) ||
      o.title.split(" at ")[1]?.trim() ||
      "Unknown vendor";
    const source = o.fulfillment === "in_app" ? "ONDC" : "Partner";
    const bps = o.fulfillment === "in_app" ? cfg.ondcMinMarginBps : cfg.partnerAffiliateMinBps;
    const fee = typeof d.convenienceFeePaise === "number" ? d.convenienceFeePaise : 0;
    const commission = Math.round((Math.max(0, o.amount - fee) * bps) / 10_000);

    const cur = byVendor.get(name) ?? {
      name,
      domain: o.domain,
      source,
      orders: 0,
      gmvPaise: 0,
      commissionPaise: 0,
    };
    cur.orders += 1;
    cur.gmvPaise += o.amount;
    cur.commissionPaise += commission;
    byVendor.set(name, cur);
  }

  const vendors = [...byVendor.values()].sort((a, b) => b.gmvPaise - a.gmvPaise);
  return {
    totalVendors: vendors.length,
    ondcVendors: vendors.filter((v) => v.source === "ONDC").length,
    vendors,
  };
}

// ---- Decision logs ------------------------------------------------------
// Real AI decisions: chat messages whose intent we captured. We surface the
// user's text, the domain it resolved to, and whether ONDC/in-app won.

export async function decisionLogs(limit = 50) {
  const messages = await prisma.chatMessage.findMany({
    where: { role: "user", intent: { not: null } },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: { content: true, intent: true, createdAt: true },
  });

  const logs = messages.map((m) => {
    const intent = m.intent ? parseDetails(m.intent) : {};
    const domain = typeof intent.domain === "string" ? intent.domain : "unknown";
    return {
      time: m.createdAt,
      intent: m.content.slice(0, 120),
      domain,
    };
  });

  const total = await prisma.chatMessage.count({
    where: { role: "user", intent: { not: null } },
  });
  return { logs, total };
}

// ---- Ranking decisions ---------------------------------------------------
// The recorded account of how a recommendation was reached. decisionLogs above
// answers "what did the user ask for"; this answers "why did that option win",
// which is the question the ONDC buyer-app disclosure commits us to being able
// to answer after the fact.

export type RankingDecision = {
  time: Date;
  domain: string;
  query: string;
  priority: string;
  weights: { price: number; rating: number; speed: number } | null;
  personalized: boolean;
  candidateCount: number;
  excludedCount: number;
  exclusions: { rule: string; count: number }[];
  chosenKey: string;
  /** Scored options, best first — the ordering that produced the pick. */
  results: {
    key: string;
    pricePaise: number;
    rating: number;
    etaMinutes: number;
    score: number;
  }[];
  /** Plain-language account of why the top option won, built from the record. */
  explanation: string;
};

// Turns a stored decision into the sentence an operator actually needs. Derived
// from the row, never from re-running the engine — re-running could disagree
// with what the user was shown, which would defeat the point of logging it.
function explain(d: {
  priority: string;
  weights: { price: number; rating: number; speed: number } | null;
  results: RankingDecision["results"];
}): string {
  const [top, next] = d.results;
  if (!top) return "No options were scored.";
  if (!next) return "Only one option was available, so it was returned by default.";

  const w = d.weights;
  const heaviest = w
    ? (["price", "rating", "speed"] as const).reduce((a, b) => (w[a] >= w[b] ? a : b))
    : null;

  const parts = [`Scored ${top.score} against ${next.score} for the next option.`];
  if (top.pricePaise < next.pricePaise) {
    parts.push(`It was ₹${Math.round((next.pricePaise - top.pricePaise) / 100)} cheaper.`);
  } else if (top.pricePaise > next.pricePaise) {
    parts.push(`It cost ₹${Math.round((top.pricePaise - next.pricePaise) / 100)} more, but won on other factors.`);
  }
  if (top.rating > next.rating) parts.push(`Rated higher (${top.rating} vs ${next.rating}).`);
  if (top.etaMinutes < next.etaMinutes) parts.push(`Faster by ${next.etaMinutes - top.etaMinutes} min.`);
  if (heaviest && w) {
    parts.push(`The "${d.priority}" preference weighted ${heaviest} highest at ${w[heaviest].toFixed(2)}.`);
  }
  return parts.join(" ");
}

export async function rankingDecisions(limit = 50) {
  const rows = await prisma.decisionLog.findMany({
    orderBy: { createdAt: "desc" },
    take: limit,
  });

  const decisions: RankingDecision[] = rows.map((r) => {
    // Stored as JSON strings; a malformed row must not take the page down.
    const safe = <T,>(raw: string | null, fallback: T): T => {
      if (!raw) return fallback;
      try {
        return JSON.parse(raw) as T;
      } catch {
        return fallback;
      }
    };
    const weights = safe<RankingDecision["weights"]>(r.weights, null);
    const results = safe<RankingDecision["results"]>(r.results, []);
    return {
      time: r.createdAt,
      domain: r.domain,
      query: r.query,
      priority: r.priority,
      weights,
      personalized: r.personalized,
      candidateCount: r.candidateCount,
      excludedCount: r.excludedCount,
      exclusions: safe<RankingDecision["exclusions"]>(r.exclusions, []),
      chosenKey: r.chosenKey,
      results,
      explanation: explain({ priority: r.priority, weights, results }),
    };
  });

  const total = await prisma.decisionLog.count();
  return { decisions, total };
}

// ---- Coupon engine ------------------------------------------------------
// Real coupons: the offers attached to paid orders. We tally how often each
// label was applied and the savings it generated.

export async function couponStats() {
  const orders = await prisma.order.findMany({
    where: { status: { in: [...PAID] } },
    select: { details: true, domain: true },
  });

  type Agg = { code: string; domain: string; timesApplied: number; savedPaise: number };
  const byCode = new Map<string, Agg>();

  for (const o of orders) {
    const d = parseDetails(o.details);
    const offers = Array.isArray(d.offers) ? (d.offers as { label?: string; discountPaise?: number }[]) : [];
    for (const off of offers) {
      const code = off.label ?? "Offer";
      const cur = byCode.get(code) ?? { code, domain: o.domain, timesApplied: 0, savedPaise: 0 };
      cur.timesApplied += 1;
      cur.savedPaise += off.discountPaise ?? 0;
      byCode.set(code, cur);
    }
  }

  const coupons = [...byCode.values()].sort((a, b) => b.savedPaise - a.savedPaise);
  return {
    activeCoupons: coupons.length,
    totalSavedPaise: coupons.reduce((s, c) => s + c.savedPaise, 0),
    coupons,
  };
}

// ---- Price alerts overview ---------------------------------------------

export async function priceAlertsOverview() {
  const [active, triggered, total] = await Promise.all([
    prisma.priceAlert.count({ where: { active: true, triggeredAt: null } }),
    prisma.priceAlert.count({ where: { triggeredAt: { not: null } } }),
    prisma.priceAlert.count(),
  ]);
  const recent = await prisma.priceAlert.findMany({
    orderBy: { createdAt: "desc" },
    take: 20,
    select: {
      id: true,
      domain: true,
      itemName: true,
      targetPaise: true,
      lastSeenPaise: true,
      active: true,
      triggeredAt: true,
    },
  });
  return { active, triggered, total, recent };
}

// ---- GMV trend (analytics) ---------------------------------------------
// Per-domain GMV from real paid orders, for the analytics bar chart.

export async function gmvByDomain() {
  const grouped = await prisma.order.groupBy({
    by: ["domain"],
    where: { status: { in: [...PAID] } },
    _sum: { amount: true },
    _count: { _all: true },
  });
  return grouped.map((g) => ({
    domain: g.domain,
    gmvPaise: g._sum.amount ?? 0,
    orders: g._count._all,
  }));
}

// ---- Trends -------------------------------------------------------------
// Daily series for the dashboard's trend cards: user growth, ONDC share and
// what customers saved. Bucketed by the Indian calendar day; a UTC bucket puts
// the first five and a half hours of every day under the day before.

const DAY_MS = 86_400_000;

export type TrendDay = {
  date: string; // YYYY-MM-DD in India
  signups: number;
  users: number; // accounts at the end of the day
  orders: number; // paid
  ondcOrders: number;
  ondcSharePct: number | null; // null on a day with no paid orders, not 0
  savedPaise: number;
};

export async function adminTrends(days = 30, now = new Date()) {
  const start = new Date(istStartOfDay(now).getTime() - (days - 1) * DAY_MS);
  const [orders, signups, usersBefore] = await Promise.all([
    prisma.order.findMany({
      where: { createdAt: { gte: start }, status: { in: [...PAID] } },
      select: { createdAt: true, fulfillment: true, savedPaise: true },
    }),
    prisma.user.findMany({ where: { createdAt: { gte: start } }, select: { createdAt: true } }),
    prisma.user.count({ where: { createdAt: { lt: start } } }),
  ]);

  const byDay = new Map<string, TrendDay>();
  for (let i = 0; i < days; i++) {
    const date = istDayKey(new Date(start.getTime() + i * DAY_MS));
    byDay.set(date, { date, signups: 0, users: 0, orders: 0, ondcOrders: 0, ondcSharePct: null, savedPaise: 0 });
  }
  for (const o of orders) {
    const day = byDay.get(istDayKey(o.createdAt));
    if (!day) continue;
    day.orders += 1;
    if (o.fulfillment === "in_app") day.ondcOrders += 1;
    day.savedPaise += o.savedPaise;
  }
  for (const u of signups) {
    const day = byDay.get(istDayKey(u.createdAt));
    if (day) day.signups += 1;
  }
  let users = usersBefore;
  const series = [...byDay.values()].map((d) => {
    users += d.signups;
    return { ...d, users, ondcSharePct: d.orders > 0 ? Math.round((d.ondcOrders / d.orders) * 100) : null };
  });
  const sum = (k: "signups" | "orders" | "ondcOrders" | "savedPaise") => series.reduce((s, d) => s + d[k], 0);
  const orderCount = sum("orders");
  return {
    days,
    series,
    totals: {
      signups: sum("signups"),
      orders: orderCount,
      ondcOrders: sum("ondcOrders"),
      ondcSharePct: orderCount > 0 ? Math.round((sum("ondcOrders") / orderCount) * 100) : null,
      savedPaise: sum("savedPaise"),
      usersAtStart: usersBefore,
      usersNow: users,
    },
  };
}

// ---- System health ------------------------------------------------------
// The admin dashboard's health panel: whether the database answers, open
// alerts, and which services are on. Configured or not, never a value: no
// key, address or account number leaves the server here.

export type ServiceState = "on" | "off" | "sandbox" | "simulated";

export async function systemHealth() {
  const started = Date.now();
  let database: { ok: boolean; latencyMs: number | null };
  try {
    await prisma.$queryRaw`SELECT 1`;
    database = { ok: true, latencyMs: Date.now() - started };
  } catch {
    database = { ok: false, latencyMs: null };
  }
  // Alerts are read from the database, so there are none to count without it.
  const alerts = database.ok ? (await systemAlerts()).counts : null;
  const set = (v?: string | number) => v != null && String(v).length > 0;
  const services: { name: string; state: ServiceState; note?: string }[] = [
    {
      name: "Payments",
      state: !(set(env.CASHFREE_APP_ID) && set(env.CASHFREE_SECRET_KEY)) ? "off" : env.CASHFREE_ENV === "production" ? "on" : "sandbox",
    },
    { name: "Email codes", state: set(env.BREVO_API_KEY) || (set(env.SMTP_HOST) && set(env.SMTP_PORT)) ? "on" : "off" },
    {
      name: "ONDC network",
      state: env.PROVIDER_MODE === "ondc" ? "on" : "simulated",
      note: env.ONDC_SEARCH_ENABLED ? "Seller search on for everyone" : "Seller search for testers only",
    },
    { name: "Chat engine", state: env.LLM_PROVIDER === "demo" ? "simulated" : "on", note: env.LLM_PROVIDER === "demo" ? "Rule-based" : undefined },
    { name: "Push notifications", state: set(env.VAPID_PUBLIC_KEY) && set(env.VAPID_PRIVATE_KEY) ? "on" : "off" },
    { name: "Maps", state: set(env.GOOGLE_MAPS_API_KEY) ? "on" : "off" },
    { name: "Error reporting", state: set(env.SENTRY_DSN) ? "on" : "off" },
  ];
  return {
    checkedAt: new Date().toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
    database,
    alerts,
    services,
  };
}

// ---- Exports ------------------------------------------------------------
// The same figures as each page, as CSV for Excel. Rupees with two decimals
// rather than paise, so a column sums to what the page shows.

export async function dashboardCsv(): Promise<string> {
  const d = await dashboardSummary();
  const rows: unknown[][] = [
    ["Total orders", d.totalOrders],
    ["GMV (INR)", rupeesCell(d.gmvPaise)],
    ["ONDC orders", d.ondcOrders],
    ["ONDC share of paid orders (%)", d.ondcSharePct],
    ["Users", d.activeUsers],
    ["New users, last 7 days", d.newUsers7d],
    ["Saved for users on paid orders (INR)", rupeesCell(d.userSavedPaise)],
    ["Revenue, total (INR)", rupeesCell(d.revenue.totalPaise)],
    ["Revenue, ONDC margin (INR)", rupeesCell(d.revenue.ondcPaise)],
    ["Revenue, partner (INR)", rupeesCell(d.revenue.partnerPaise)],
    ["Revenue, convenience fee (INR)", rupeesCell(d.revenue.conveniencePaise)],
    ...d.domainBreakdown.map((x) => [`Paid orders, ${x.domain}`, x.count]),
  ];
  return toCsv(["Metric", "Value"], rows);
}

export async function analyticsCsv(): Promise<string> {
  const domains = await gmvByDomain();
  return toCsv(
    ["Domain", "Paid orders", "GMV (INR)"],
    domains.map((x) => [x.domain, x.orders, rupeesCell(x.gmvPaise)]),
  );
}

export async function citiesCsv(filter: Parameters<typeof cityReport>[0]): Promise<string> {
  const { rows } = await cityReport(filter);
  return toCsv(
    ["Rank", "City", "State", "Tier", "Orders", "GMV (INR)", "Saved (INR)", "Coverage"],
    rows.map((r) => [r.rank, r.city, r.state, r.tier, r.orders, rupeesCell(r.gmvPaise), rupeesCell(r.savedPaise), r.demo ? "demo" : "live"]),
  );
}

export async function vendorsCsv(): Promise<string> {
  const { vendors } = await vendorReport();
  return toCsv(
    ["Vendor", "Domain", "Source", "Orders", "GMV (INR)", "Commission (INR)"],
    vendors.map((v) => [v.name, v.domain, v.source, v.orders, rupeesCell(v.gmvPaise), rupeesCell(v.commissionPaise)]),
  );
}

export async function trendsCsv(days: number): Promise<string> {
  const { series } = await adminTrends(days);
  return toCsv(
    ["Date", "New users", "Users", "Paid orders", "ONDC orders", "ONDC share (%)", "Saved (INR)"],
    series.map((d) => [d.date, d.signups, d.users, d.orders, d.ondcOrders, d.ondcSharePct ?? "", rupeesCell(d.savedPaise)]),
  );
}
