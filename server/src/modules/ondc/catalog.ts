// Reads a seller app's on_search catalogue (ONDC:RET11, Beckn 1.2.0) into
// what a customer is shown: each dish, with the store selling it.
//
// A single search reaches every food seller app on the network, and each one
// answers with its own stores ("providers") and their menus. Built against
// catalogues real seller apps sent in certified flows ONDC publishes
// (v1.2.0-logs): a full refresh from the Pramaan mock seller, Eatiko,
// Digivipani and Green Receipt.
//
// What is left out, and why:
//   - Customisations (crusts, toppings) are not dishes. They are offered once
//     a dish is chosen, so they never appear as results.
//   - A store or item the seller has switched off (time.label "disable"), or
//     an item with nothing in stock, cannot be ordered and is not shown.
//   - An item whose price is not a rupee amount is dropped rather than shown
//     at a guessed price.

export type OndcSeller = {
  /** The seller app, as registered on ONDC. */
  bppId: string;
  bppUri: string;
  /** The seller app's own name ("Digivipani"). */
  appName: string;
  providerId: string;
  /** The store ("Tim Hortons-Bandra"). */
  name: string;
  logo?: string;
  locationId: string;
  address: { street?: string; locality?: string; city?: string; state?: string; areaCode?: string };
  gps?: { lat: number; lng: number };
  fssaiLicence?: string;
  /**
   * How far this store delivers food, from its serviceability tag: a radius
   * in km (type 10), or the whole country (type 12). Absent when the seller
   * declared another kind (pincode lists, polygons) this does not read.
   */
  delivers?: { radiusKm: number } | { nationwide: true };
};

export type OndcOffer = {
  seller: OndcSeller;
  itemId: string;
  name: string;
  description?: string;
  image?: string;
  categoryId?: string;
  /** The item's price, before customisations. */
  pricePaise: number;
  /** True when choices such as size or crust can change the price. */
  customizable: boolean;
  /** Null when the seller did not say. */
  veg: boolean | null;
  /** How long the seller takes to send it out, in minutes, when stated. */
  timeToShipMinutes?: number;
};

type Wire = Record<string, unknown>;
const obj = (v: unknown): Wire => (v && typeof v === "object" && !Array.isArray(v) ? (v as Wire) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** "265" or "265.50" to paise; anything else is not a price. */
export function paiseFromRupees(v: unknown): number | null {
  const s = typeof v === "number" ? String(v) : str(v);
  if (!s || !/^\d{1,7}(\.\d{1,2})?$/.test(s)) return null;
  return Math.round(Number(s) * 100);
}

/** ISO 8601 durations as sellers write them ("PT40M", "PT1H", "P1D"), in minutes. */
export function minutesFromDuration(v: unknown): number | undefined {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/.exec(str(v) ?? "");
  if (!m || (!m[1] && !m[2] && !m[3])) return undefined;
  return Number(m[1] ?? 0) * 1440 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
}

function gpsOf(v: unknown): { lat: number; lng: number } | undefined {
  const m = /^\s*(-?\d{1,3}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$/.exec(str(v) ?? "");
  if (!m) return undefined;
  const lat = Number(m[1]);
  const lng = Number(m[2]);
  return Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : undefined;
}

/** A tag's value, from Beckn 1.2.0's {code, list: [{code, value}]} form. */
function tag(tags: unknown, code: string, key: string): string | undefined {
  for (const t of arr(tags)) {
    const tt = obj(t);
    if (tt.code !== code) continue;
    for (const e of arr(tt.list)) {
      const ee = obj(e);
      if (ee.code === key) return str(ee.value);
    }
  }
  return undefined;
}

const enabled = (time: unknown) => obj(time).label !== "disable";

/** The food serviceability a store declared for one of its locations. */
function deliveryArea(tags: unknown, locationId: string): OndcSeller["delivers"] {
  for (const t of arr(tags)) {
    const tt = obj(t);
    if (tt.code !== "serviceability") continue;
    const kv = Object.fromEntries(arr(tt.list).map((e) => [str(obj(e).code), str(obj(e).value)]));
    if (kv.location && kv.location !== locationId) continue;
    if (kv.category && kv.category !== "F&B") continue;
    if (kv.type === "10" && kv.unit === "km" && Number(kv.val) > 0) return { radiusKm: Number(kv.val) };
    if (kv.type === "12" && kv.val === "IND") return { nationwide: true };
  }
  return undefined;
}

export function parseOnSearch(body: unknown): OndcOffer[] {
  const root = obj(body);
  const context = obj(root.context);
  const bppId = str(context.bpp_id);
  const bppUri = str(context.bpp_uri);
  if (!bppId || !bppUri) return [];
  const catalog = obj(obj(root.message).catalog);
  const appName = str(obj(catalog["bpp/descriptor"]).name) ?? bppId;

  const offers: OndcOffer[] = [];
  for (const p of arr(catalog["bpp/providers"])) {
    const provider = obj(p);
    const providerId = str(provider.id);
    const name = str(obj(provider.descriptor).name);
    if (!providerId || !name || !enabled(provider.time)) continue;

    const locations = new Map<string, Wire>();
    for (const l of arr(provider.locations)) {
      const loc = obj(l);
      const id = str(loc.id);
      if (id && enabled(loc.time)) locations.set(id, loc);
    }
    const logo = str(obj(provider.descriptor).symbol) ?? str(arr(obj(provider.descriptor).images)[0]);
    const fssai = str(provider["@ondc/org/fssai_license_no"]);

    for (const i of arr(provider.items)) {
      const item = obj(i);
      const itemId = str(item.id);
      const descriptor = obj(item.descriptor);
      const itemName = str(descriptor.name);
      if (!itemId || !itemName || !enabled(item.time)) continue;
      // Customisations are chosen with a dish, never on their own.
      if ((tag(item.tags, "type", "type") ?? "item") !== "item") continue;
      const available = obj(obj(item.quantity).available).count;
      if (available !== undefined && Number(available) <= 0) continue;
      const price = obj(item.price);
      const pricePaise = paiseFromRupees(price.value);
      if (pricePaise === null || pricePaise <= 0) continue;

      // The item's store location; one the seller has closed or not listed
      // means it cannot be ordered from here.
      const locationId = str(item.location_id) ?? (locations.size === 1 ? [...locations.keys()][0] : undefined);
      const loc = locationId ? locations.get(locationId) : undefined;
      if (!locationId || !loc) continue;
      const address = obj(loc.address);

      const vegTag = tag(item.tags, "veg_nonveg", "veg");
      const nonVegTag = tag(item.tags, "veg_nonveg", "non_veg");
      const veg = vegTag === "yes" ? true : nonVegTag === "yes" || vegTag === "no" ? false : null;
      const rangeUpper = tag(price.tags, "range", "upper");

      offers.push({
        seller: {
          bppId,
          bppUri,
          appName,
          providerId,
          name,
          ...(logo ? { logo } : {}),
          locationId,
          address: {
            street: str(address.street),
            locality: str(address.locality),
            city: str(address.city),
            state: str(address.state),
            areaCode: str(address.area_code),
          },
          ...(gpsOf(loc.gps) ? { gps: gpsOf(loc.gps) } : {}),
          ...(fssai ? { fssaiLicence: fssai } : {}),
          ...(deliveryArea(provider.tags, locationId) ? { delivers: deliveryArea(provider.tags, locationId) } : {}),
        },
        itemId,
        name: itemName,
        ...(str(descriptor.short_desc) && descriptor.short_desc !== itemName ? { description: str(descriptor.short_desc) } : {}),
        ...(str(arr(descriptor.images)[0]) ? { image: str(arr(descriptor.images)[0]) } : {}),
        ...(str(item.category_id) ? { categoryId: str(item.category_id) } : {}),
        pricePaise,
        customizable: Boolean(rangeUpper) || tag(item.tags, "custom_group", "id") !== undefined,
        veg,
        ...(minutesFromDuration(item["@ondc/org/time_to_ship"]) !== undefined
          ? { timeToShipMinutes: minutesFromDuration(item["@ondc/org/time_to_ship"]) }
          : {}),
      });
    }
  }
  return offers;
}

/** Straight-line distance in kilometres. */
export function distanceKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}

// ---------------------------------------------------------------------------
// Options on a dish (ONDC "customisations")
//
// A dish names the option groups it starts with (its custom_group tags). Each
// group is a category of type custom_group with its own rule: pick at least
// `min` and at most `max`. Each option belongs to one group (its parent tag)
// and may open further groups when chosen (its child tags): a crust opens
// sizes, a size opens toppings. So what can be chosen depends on what has
// been chosen, and a choice is only valid if it follows that tree.

export type OptionGroup = { id: string; name: string; min: number; max: number; seq: number; options: Option[] };
export type Option = { id: string; name: string; pricePaise: number; isDefault: boolean; opens: string[]; veg: boolean | null };
export type OptionTree = { starts: string[]; groups: Record<string, OptionGroup> };

function tagValues(tags: unknown, code: string, key: string): string[] {
  const out: string[] = [];
  for (const t of arr(tags)) {
    const tt = obj(t);
    if (tt.code !== code) continue;
    for (const e of arr(tt.list)) {
      const ee = obj(e);
      if (ee.code === key && str(ee.value)) out.push(str(ee.value)!);
    }
  }
  return out;
}

/** The option tree for one dish in one seller's catalogue, or null if the dish has no options or is not there. */
/** Whether a seller's catalogue carries this store at all. */
export function listsProvider(body: unknown, providerId: string): boolean {
  const catalog = obj(obj(obj(body).message).catalog);
  return arr(catalog["bpp/providers"]).map(obj).some((p) => str(p.id) === providerId);
}

export function optionsFor(body: unknown, providerId: string, itemId: string): OptionTree | null {
  const catalog = obj(obj(obj(body).message).catalog);
  const provider = arr(catalog["bpp/providers"]).map(obj).find((p) => str(p.id) === providerId);
  if (!provider) return null;
  const items = arr(provider.items).map(obj);
  const dish = items.find((i) => str(i.id) === itemId);
  if (!dish) return null;
  const starts = tagValues(dish.tags, "custom_group", "id");
  if (starts.length === 0) return null;

  const groups: Record<string, OptionGroup> = {};
  for (const c of arr(provider.categories).map(obj)) {
    const id = str(c.id);
    if (!id || tag(c.tags, "type", "type") !== "custom_group") continue;
    const min = Number(tag(c.tags, "config", "min") ?? 0);
    const max = Number(tag(c.tags, "config", "max") ?? 1);
    if (!Number.isInteger(min) || !Number.isInteger(max) || min < 0 || max < Math.max(min, 1)) continue;
    groups[id] = { id, name: str(obj(c.descriptor).name) ?? id, min, max, seq: Number(tag(c.tags, "config", "seq") ?? 0) || 0, options: [] };
  }
  for (const i of items) {
    if (tag(i.tags, "type", "type") !== "customization") continue;
    const id = str(i.id);
    const group = groups[tag(i.tags, "parent", "id") ?? ""];
    const pricePaise = paiseFromRupees(obj(i.price).value);
    if (!id || !group || pricePaise === null || !enabled(i.time)) continue;
    const available = obj(obj(i.quantity).available).count;
    if (available !== undefined && Number(available) <= 0) continue;
    const vegTag = tag(i.tags, "veg_nonveg", "veg");
    group.options.push({
      id,
      name: str(obj(i.descriptor).name) ?? id,
      pricePaise,
      isDefault: tag(i.tags, "parent", "default") === "yes",
      opens: tagValues(i.tags, "child", "id").filter((g) => groups[g] !== undefined),
      veg: vegTag === "yes" ? true : vegTag === "no" ? false : null,
    });
  }
  // A starting group the seller never defined cannot be satisfied.
  if (starts.some((g) => !groups[g])) return null;
  return { starts, groups };
}

/**
 * Checks a set of chosen option ids against the tree. Returns the group of
 * each chosen option, in the order they were chosen, or the first rule broken.
 */
export function checkChoices(tree: OptionTree, chosen: string[]): { picks: { itemId: string; groupId: string }[] } | { problem: string } {
  if (new Set(chosen).size !== chosen.length) return { problem: "An option was chosen twice" };
  const remaining = new Set(chosen);
  const picks: { itemId: string; groupId: string }[] = [];
  const visited = new Set<string>();
  const queue = [...tree.starts];
  while (queue.length) {
    const g = tree.groups[queue.shift()!]!;
    if (visited.has(g.id)) continue;
    visited.add(g.id);
    const inGroup = g.options.filter((o) => remaining.has(o.id));
    if (inGroup.length < g.min) return { problem: `Choose at least ${g.min} from ${g.name}` };
    if (inGroup.length > g.max) return { problem: `Choose at most ${g.max} from ${g.name}` };
    for (const o of inGroup) {
      remaining.delete(o.id);
      picks.push({ itemId: o.id, groupId: g.id });
      queue.push(...o.opens);
    }
  }
  if (remaining.size) return { problem: `Not an option for this dish: ${[...remaining].join(", ")}` };
  return { picks };
}
