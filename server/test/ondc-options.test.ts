import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { env } from "../src/config/env.js";
import { checkChoices, optionsFor } from "../src/modules/ondc/catalog.js";
import { dishOptions, startOndcOrder } from "../src/modules/ondc/orders.service.js";
import { authedAgent } from "./helpers.js";
import { customerWithSearch, fx, recorder, reply, SELLER } from "./ondc-order-helpers.js";

// Dishes with options (ONDC customisations), read from ONDC's mock seller's
// real catalogue: a pizza whose crust opens sizes, whose size opens toppings.

const catalogue = fx("on_search_pramaan");
const tree = optionsFor(catalogue, "pramaan_provider_1", "id_ancc5_0_0")!;

describe("reading a dish's options", () => {
  it("reads the groups, their rules and what each choice opens", () => {
    expect(tree.starts).toEqual(["CG11"]);
    expect(tree.groups.CG11).toMatchObject({ name: "Crust(any 1 option)", min: 1, max: 1 });
    expect(tree.groups.CG11!.options.map((o) => o.id)).toEqual(["id_1bai73_1_0", "id_5yzai_2_0"]);
    expect(tree.groups.CG11!.options[0]).toMatchObject({ opens: ["CG21"], isDefault: true });
    expect(tree.groups.CG21!.options.find((o) => o.name === "Medium")).toMatchObject({ pricePaise: 2500, opens: ["CG31"] });
    expect(tree.groups.CG31).toMatchObject({ min: 0, max: 2 });
    expect(tree.groups.CG31!.options.map((o) => o.name)).toEqual(["Fresh Tomato", "Grilled Mushrooms", "Pepper Barbeque Chicken"]);
  });

  it("finds no options on a dish that has none, or one the catalogue does not list", () => {
    expect(optionsFor(catalogue, "pramaan_provider_1", "id_1cctu3_9_0")).toBeNull();
    expect(optionsFor(catalogue, "pramaan_provider_1", "no_such_item")).toBeNull();
    expect(optionsFor(catalogue, "other_provider", "id_ancc5_0_0")).toBeNull();
  });
});

describe("checking a choice against the seller's rules", () => {
  it("accepts a crust, a size and up to two toppings, and names each one's group", () => {
    expect(checkChoices(tree, ["id_5yzai_2_0", "id_55vxa_5_0", "id_gp97d_7_0"])).toEqual({
      picks: [
        { itemId: "id_5yzai_2_0", groupId: "CG11" },
        { itemId: "id_55vxa_5_0", groupId: "CG21" },
        { itemId: "id_gp97d_7_0", groupId: "CG31" },
      ],
    });
  });

  it("refuses what the seller's rules do not allow", () => {
    expect(checkChoices(tree, [])).toEqual({ problem: "Choose at least 1 from Crust(any 1 option)" });
    expect(checkChoices(tree, ["id_1bai73_1_0", "id_5yzai_2_0", "id_c2egb_3_0"])).toEqual({ problem: "Choose at most 1 from Crust(any 1 option)" });
    // A crust without a size: the size group it opens needs one.
    expect(checkChoices(tree, ["id_1bai73_1_0"])).toEqual({ problem: "Choose at least 1 from Size (any 1 option)" });
    expect(checkChoices(tree, ["id_1bai73_1_0", "id_c2egb_3_0", "id_12xdek_6_0", "id_gp97d_7_0", "id_16vmqe_8_0"])).toEqual({
      problem: "Choose at most 2 from Toppings (up to 2 options)",
    });
    expect(checkChoices(tree, ["id_1bai73_1_0", "id_c2egb_3_0", "id_1cctu3_9_0"])).toEqual({ problem: "Not an option for this dish: id_1cctu3_9_0" });
    expect(checkChoices(tree, ["id_1bai73_1_0", "id_1bai73_1_0"])).toEqual({ problem: "An option was chosen twice" });
  });
});

describe("ordering a dish with options", () => {
  it("sends the options with the groups from the catalogue and one line id tying them to the dish", async () => {
    const c = await customerWithSearch();
    const r = recorder();
    await startOndcOrder(
      c.userId,
      {
        searchId: c.searchId,
        bppId: SELLER,
        providerId: "pramaan_provider_1",
        locationId: "SSL1",
        // No groups given: the server takes them from the catalogue.
        lines: [{ itemId: "id_ancc5_0_0", count: 2, customizations: [{ itemId: "id_5yzai_2_0" }, { itemId: "id_18yq4w_4_0" }] }],
      },
      r.deps,
    );
    const items = r.last().envelope.message.order.items;
    expect(items).toHaveLength(3);
    const lineId = items[0].parent_item_id;
    expect(lineId).toMatch(/^[0-9a-f]{10}$/);
    expect(items.every((i: { parent_item_id: string }) => i.parent_item_id === lineId)).toBe(true);
    expect(items.map((i: { quantity: { count: number } }) => i.quantity.count)).toEqual([2, 2, 2]);
    expect(items[1].tags).toContainEqual({ code: "parent", list: [{ code: "id", value: "CG11" }] });
    expect(items[2].tags).toContainEqual({ code: "parent", list: [{ code: "id", value: "CG21" }] });
  });

  it("refuses a choice the seller's rules do not allow before anything is sent", async () => {
    const c = await customerWithSearch();
    const r = recorder();
    const start = (customizations?: { itemId: string }[]) =>
      startOndcOrder(c.userId, { searchId: c.searchId, bppId: SELLER, providerId: "pramaan_provider_1", locationId: "SSL1", lines: [{ itemId: "id_ancc5_0_0", count: 1, customizations }] }, r.deps);
    await expect(start()).rejects.toThrow(/at least 1 from Crust/);
    await expect(start([{ itemId: "id_1bai73_1_0" }])).rejects.toThrow(/at least 1 from Size/);
    expect(r.sent).toHaveLength(0);
  });

  it("shows a dish's options to the customer who searched, and no one else", async () => {
    const c = await customerWithSearch();
    const query = `searchId=${c.searchId}&bppId=${encodeURIComponent(SELLER)}&providerId=pramaan_provider_1&itemId=id_ancc5_0_0`;
    env.ONDC_SEARCH_ENABLED = true;
    try {
      const res = await c.agent.get(`/api/ondc/orders/options?${query}`).expect(200);
      expect(res.body.options.starts).toEqual(["CG11"]);
      const stranger = await authedAgent();
      await stranger.agent.get(`/api/ondc/orders/options?${query}`).expect(404);
      await c.agent.get(`/api/ondc/orders/options?searchId=x`).expect(400);
    } finally {
      env.ONDC_SEARCH_ENABLED = false;
    }
  });
});

// A seller can send a fresh catalogue during a search. Options used to be read
// from any of its last five answers, so a dish whose options the seller had
// removed still offered them from an older one, and the seller then refused
// the order at select.
describe("which catalogue a dish's options come from", () => {
  type Provider = { id: string; items: { id: string; tags: { code: string }[] }[] };

  it("takes the store's newest catalogue, even when it has dropped the options", async () => {
    const c = await customerWithSearch();
    const fresh = fx("on_search_pramaan");
    const store = (fresh.message.catalog["bpp/providers"] as Provider[]).find((p) => p.id === "pramaan_provider_1")!;
    const pizza = store.items.find((i) => i.id === "id_ancc5_0_0")!;
    pizza.tags = pizza.tags.filter((t) => t.code !== "custom_group");
    await reply("on_search", fresh, { txnId: c.searchId, messageId: crypto.randomUUID() }).expect(200);
    expect(await dishOptions(c.userId, c.searchId, SELLER, "pramaan_provider_1", "id_ancc5_0_0")).toBeNull();
  });

  it("looks past a newer answer about the seller's other stores", async () => {
    const c = await customerWithSearch();
    const other = fx("on_search_pramaan");
    other.message.catalog["bpp/providers"] = (other.message.catalog["bpp/providers"] as Provider[]).map((p) => ({ ...p, id: `${p.id}_other` }));
    await reply("on_search", other, { txnId: c.searchId, messageId: crypto.randomUUID() }).expect(200);
    expect((await dishOptions(c.userId, c.searchId, SELLER, "pramaan_provider_1", "id_ancc5_0_0"))?.starts).toEqual(["CG11"]);
  });
});
