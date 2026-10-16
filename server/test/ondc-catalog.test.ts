import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { distanceKm, minutesFromDuration, paiseFromRupees, parseOnSearch } from "../src/modules/ondc/catalog.js";

// Catalogues four real seller apps sent in certified RET11 flows that ONDC
// publishes (v1.2.0-logs), trimmed to a dozen dishes per store.
const fixtures = JSON.parse(readFileSync(new URL("./fixtures/ondc-ret11-on_search.json", import.meta.url), "utf8")) as Record<string, any>;

describe("reading a seller's catalogue", () => {
  it("reads every seller app's stores, with the details a customer is shown", () => {
    const pramaan = parseOnSearch(fixtures.Easy_Pay);
    const stores = new Set(pramaan.map((o) => o.seller.name));
    expect(stores).toEqual(new Set(["Pramaan Store 1", "Pramaan Store 2"]));
    const pizza = pramaan.find((o) => o.name === "Farmhouse Pizza" && o.seller.providerId === "pramaan_provider_1")!;
    expect(pizza).toMatchObject({
      pricePaise: 26500,
      customizable: true,
      veg: true,
      seller: {
        bppId: "pramaan.ondc.org/beta/preprod/mock/seller",
        appName: "ONDC Pramaan Seller Services",
        name: "Pramaan Store 1",
        locationId: "SSL1",
        address: { city: "New Delhi" },
        gps: { lat: 28.5273, lng: 77.1821 },
      },
    });
    expect(pizza.seller.fssaiLicence).toBeTruthy();
    expect(pizza.seller.delivers).toEqual({ nationwide: true });
    expect(parseOnSearch(fixtures.Buynxt_Greenreceipt)[0]!.seller.delivers).toEqual({ radiusKm: 3 });
  });

  it("works across different seller apps' layouts", () => {
    for (const [name, expected] of [
      ["DIGILEDGE", "The Food and Bevarage Store"],
      ["Buynxt_Greenreceipt", "Tim Hortons-Bandra"],
      ["EATIKO_SELLER_APP", "EATIKO OFFICIAL PROVIDER"],
    ] as const) {
      const offers = parseOnSearch(fixtures[name]);
      expect(offers.length, name).toBeGreaterThan(0);
      expect(offers.every((o) => o.seller.name === expected), name).toBe(true);
      expect(offers.every((o) => Number.isInteger(o.pricePaise) && o.pricePaise > 0), name).toBe(true);
    }
    expect(parseOnSearch(fixtures.Buynxt_Greenreceipt)[0]!.seller).toMatchObject({ appName: "Green Receipt", address: { city: "Mumbai" } });
  });

  it("never offers a customisation as a dish, even a priced one", () => {
    const base = structuredClone(fixtures.Easy_Pay);
    for (const p of base.message.catalog["bpp/providers"]) {
      for (const i of p.items) if (i.descriptor.name === "New Hand Tossed") i.price.value = "50";
    }
    expect(parseOnSearch(base).map((o) => o.name)).not.toContain("New Hand Tossed");
  });

  it("leaves out what cannot be ordered: a closed store, a switched off or sold out item, a price that is not a price", () => {
    const base = structuredClone(fixtures.Easy_Pay);
    const [store1, store2] = base.message.catalog["bpp/providers"];
    store2.time = { label: "disable", timestamp: "2025-01-01T00:00:00.000Z" };
    store1.items[0].time = { label: "disable" };
    store1.items[1].quantity = { available: { count: "0" } };
    store1.items[2].price.value = "free";
    const offers = parseOnSearch(base);
    expect(offers.some((o) => o.seller.name === "Pramaan Store 2")).toBe(false);
    const ids = offers.map((o) => o.itemId);
    for (const i of [0, 1, 2]) expect(ids).not.toContain(store1.items[i].id);
  });

  it("drops an item at a store location the seller did not list", () => {
    const base = structuredClone(fixtures.Easy_Pay);
    base.message.catalog["bpp/providers"][0].items[0].location_id = "NOT-A-STORE";
    const first = base.message.catalog["bpp/providers"][0].items[0].id;
    expect(parseOnSearch(base).map((o) => o.itemId)).not.toContain(first);
  });

  it("returns nothing for a message with no seller app named", () => {
    expect(parseOnSearch({})).toEqual([]);
    expect(parseOnSearch({ context: { bpp_id: "x" }, message: {} })).toEqual([]);
  });

  it("reads prices, durations and distances the way sellers write them", () => {
    expect(paiseFromRupees("265")).toBe(26500);
    expect(paiseFromRupees("430.5")).toBe(43050);
    expect(paiseFromRupees("12.345")).toBeNull();
    expect(paiseFromRupees("-1")).toBeNull();
    expect(minutesFromDuration("PT40M")).toBe(40);
    expect(minutesFromDuration("PT1H")).toBe(60);
    expect(minutesFromDuration("P1D")).toBe(1440);
    expect(minutesFromDuration("soon")).toBeUndefined();
    // Bandra to Andheri is about 8 km as the crow flies.
    expect(distanceKm({ lat: 19.0596, lng: 72.8295 }, { lat: 19.1136, lng: 72.8697 })).toBeCloseTo(7.3, 0);
  });
});
