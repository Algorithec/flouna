import { describe, expect, it } from "vitest";
import { buildConfirm, buildInit, buildSearch, buildSelect, buildStatus, rupees } from "../src/modules/ondc/retail.js";

// The food builders, held to what a buyer app sent in a certified ONDC
// pre-prod flow (ONDC-Official/v1.2.0-logs, WITSLAB buyer, RET11 Flow 2).
// ONDC's certification compares these messages field by field, so the
// expected values below are copied from that log, not written from memory.

const bpp = { id: "extweb.oyeti.com/ecommerce/ondc", uri: "https://extweb.oyeti.com/ecommerce/ondc" };
const base = {
  transactionId: "t-1",
  city: "std:080",
  bpp,
  providerId: "1039535",
  locationId: "378278",
  lines: [
    {
      itemId: "13691091",
      count: 1,
      parentItemId: "UeXmfc/k6EaZ",
      customizations: [
        { itemId: "Variant@988006", groupId: "Size-91091" },
        { itemId: "936461-13691126", groupId: "Addon-91091" },
        { itemId: "936461-13691125", groupId: "Addon-91091" },
      ],
    },
  ],
};
const address = { name: "Testing", building: "BSNL RAJBHAVAN", locality: "Dr Ambedkar Road", city: "Bengaluru", state: "Karnataka", areaCode: "560001" };
const at = new Date("2024-08-24T04:27:44.240Z");

describe("food messages match a certified ONDC flow", () => {
  it("select: a pizza with a size variant and two add-ons", () => {
    const m = buildSelect({ ...base, gps: "12.980869,77.594826", areaCode: "560001" });
    expect(m.context).toMatchObject({ action: "select", bpp_id: bpp.id, bpp_uri: bpp.uri, core_version: "1.2.0" });
    expect(m.message.order.provider).toEqual({ id: "1039535", locations: [{ id: "378278" }] });
    expect(m.message.order.items).toEqual([
      { id: "13691091", quantity: { count: 1 }, location_id: "378278", tags: [{ code: "type", list: [{ code: "type", value: "item" }] }], parent_item_id: "UeXmfc/k6EaZ" },
      { id: "Variant@988006", quantity: { count: 1 }, location_id: "378278", tags: [{ code: "type", list: [{ code: "type", value: "customization" }] }, { code: "parent", list: [{ code: "id", value: "Size-91091" }] }], parent_item_id: "UeXmfc/k6EaZ" },
      { id: "936461-13691126", quantity: { count: 1 }, location_id: "378278", tags: [{ code: "type", list: [{ code: "type", value: "customization" }] }, { code: "parent", list: [{ code: "id", value: "Addon-91091" }] }], parent_item_id: "UeXmfc/k6EaZ" },
      { id: "936461-13691125", quantity: { count: 1 }, location_id: "378278", tags: [{ code: "type", list: [{ code: "type", value: "customization" }] }, { code: "parent", list: [{ code: "id", value: "Addon-91091" }] }], parent_item_id: "UeXmfc/k6EaZ" },
    ]);
    expect(m.message.order.fulfillments).toEqual([{ end: { location: { gps: "12.980869,77.594826", address: { area_code: "560001" } } } }]);
  });

  it("init: billing and delivery exactly as certified", () => {
    const m = buildInit({
      ...base,
      billing: { name: "Testing", phone: "9009009009", email: "test@witslab.com", address, at },
      delivery: { fulfillmentId: "c0e8b1ff-bc6f-4af7-a4e5-94a33bd92a53", gps: "12.980869,77.594826", address, phone: "9009009009", email: "test@witslab.com" },
    });
    expect(m.message.order.billing).toEqual({
      address: { building: "BSNL RAJBHAVAN", city: "Bengaluru", state: "Karnataka", country: "IND", area_code: "560001", locality: "Dr Ambedkar Road", name: "Testing" },
      phone: "9009009009", name: "Testing", email: "test@witslab.com", created_at: "2024-08-24T04:27:44.240Z", updated_at: "2024-08-24T04:27:44.240Z",
    });
    expect(m.message.order.fulfillments).toEqual([{
      id: "c0e8b1ff-bc6f-4af7-a4e5-94a33bd92a53", type: "Delivery",
      end: {
        contact: { email: "test@witslab.com", phone: "9009009009" },
        location: { gps: "12.980869,77.594826", address: { building: "BSNL RAJBHAVAN", city: "Bengaluru", state: "Karnataka", country: "IND", area_code: "560001", locality: "Dr Ambedkar Road", name: "Testing" } },
      },
    }]);
  });

  it("search: a delivery intent carrying the finder fee", () => {
    const m = buildSearch({ transactionId: "t", city: "std:080", finderFeePercent: 3 });
    expect(m.message).toEqual({
      intent: { fulfillment: { type: "Delivery" }, payment: { "@ondc/org/buyer_app_finder_fee_type": "percent", "@ondc/org/buyer_app_finder_fee_amount": "3.0" } },
    });
  });
});

describe("confirm", () => {
  const quote = { price: { currency: "INR", value: "678.89" }, breakup: [{ title: "Pepper Barbeque Chicken Pizza" }] };
  const settlement = [{ settlement_counterparty: "seller-app", settlement_phase: "sale-amount", settlement_type: "neft" }];
  const confirm = (collectedBy: "BAP" | "BPP") =>
    buildConfirm({
      ...base,
      orderId: "o-1",
      billing: { name: "Testing", phone: "9009009009", email: "test@witslab.com", address, at },
      delivery: { fulfillmentId: "f-1", gps: "12.980869,77.594826", address, phone: "9009009009", email: "test@witslab.com", personName: "Testing", tat: "PT60M" },
      quote,
      payment: { collectedBy, amountPaise: 67889, gatewayTransactionId: "order_X", paid: collectedBy === "BAP", finderFeePercent: 3, settlementDetails: settlement },
    });

  it("echoes the seller's quote and settlement terms untouched", () => {
    const m = confirm("BAP");
    expect(m.message.order.quote).toBe(quote);
    expect(m.message.order.payment["@ondc/org/settlement_details"]).toBe(settlement);
  });

  it("states the amount in rupees from integer paise, and who collected it", () => {
    expect(confirm("BAP").message.order.payment).toMatchObject({ collected_by: "BAP", status: "PAID", params: { amount: "678.89", currency: "INR", transaction_id: "order_X" } });
    expect(confirm("BPP").message.order.payment).toMatchObject({ collected_by: "BPP", status: "NOT-PAID" });
  });
});

describe("money and status", () => {
  it("converts paise to a two-decimal rupee string and refuses anything else", () => {
    expect(rupees(67889)).toBe("678.89");
    expect(rupees(15000)).toBe("150.00");
    expect(rupees(5)).toBe("0.05");
    expect(() => rupees(12.5)).toThrow();
    expect(() => rupees(-1)).toThrow();
  });

  it("asks for an order's status by id", () => {
    expect(buildStatus({ transactionId: "t", city: "std:080", bpp, orderId: "o-1" }).message).toEqual({ order_id: "o-1" });
  });
});
