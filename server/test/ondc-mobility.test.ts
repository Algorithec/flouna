import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { buildRideConfirm, buildRideInit, buildRideSearch, buildRideSelect, buildRideStatus } from "../src/modules/ondc/mobility.js";

// The ride builders, held to ONDC's own examples for ride hailing (TRV10,
// version 2.0.1), copied into the fixture from ONDC-Official/
// mobility-specification, branch draft-TRV10-2.x. Each builder is given the
// example's inputs and must produce the example's message exactly.

const ex = JSON.parse(fs.readFileSync(new URL("./fixtures/ondc-trv10-examples.json", import.meta.url), "utf8"));

const pickup = { gps: "13.008935, 77.644408", address: "Banaswadi, Bengaluru - 560043, Karnataka, India", area: "Banaswadi" };
const drop = { gps: "12.971186, 77.586812", address: "Sampangiram Nagar Ward, Bengaluru - 560001, Karnataka, India", area: "Sampangiram Nagar" };
const base = {
  transactionId: "t-1",
  city: "std:080",
  bpp: { id: "example-bpp.com", uri: "https://example-bpp.com/prod/seller" },
  providerId: "P1",
  itemId: "I1",
  fulfillmentId: "F1",
  vehicle: "AUTO_RICKSHAW" as const,
  pickup,
  drop,
};
const customer = { name: "Joe Adams", phone: "9876556789" };

describe("ride messages match ONDC's TRV10 2.0.1 examples", () => {
  it("search between two points, provider collects, with Flouna's finder fee", () => {
    const m = buildRideSearch({ transactionId: "t", city: "std:080", pickup, drop, finderFeePercent: 1, staticTermsUrl: "https://example-test-bap.com/static-terms.txt" });
    expect(m.message).toEqual(ex.search);
    expect(m.context).toMatchObject({ version: "2.0.1", domain: "ONDC:TRV10", location: { city: { code: "std:080" }, country: { code: "IND" } } });
  });

  it("select one offered auto ride", () => {
    expect(buildRideSelect(base).message).toEqual(ex.select);
  });

  it("init with the rider, echoing the provider's settlement terms", () => {
    const p = ex.init.order.payments[0];
    const m = buildRideInit({ ...base, customer, payment: { collectedBy: "BPP", params: p.params, tags: p.tags } });
    expect(m.message).toEqual(ex.init);
  });

  it("confirm on the terms returned in on_init", () => {
    const p = ex.confirm.order.payments[0];
    const m = buildRideConfirm({ ...base, customer, payment: { collectedBy: "BPP", params: p.params, tags: p.tags, id: p.id } });
    expect(m.message).toEqual(ex.confirm);
  });

  it("asks a ride's status by order id", () => {
    expect(buildRideStatus({ transactionId: "t", city: "std:080", bpp: base.bpp, orderId: "O1" }).message).toEqual({ order_id: "O1" });
  });
});
