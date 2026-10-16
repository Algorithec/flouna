import { describe, expect, it } from "vitest";
import { commercialTerms } from "../src/modules/ondc/commercial.js";

// Flouna's commercial terms on ONDC, as configuration. Three are the
// founder's to decide (who collects food payments, the finder fee, the
// account it is paid into); until they are set, the defaults let everything
// run without committing the company to anything it has not chosen, and say
// so.

describe("ONDC commercial terms", () => {
  it("defaults to the seller collecting, the certified flows' fee, and no account, each flagged", () => {
    const t = commercialTerms({});
    expect(t.foodCollectedBy).toBe("BPP");
    expect(t.finderFeePercent).toBe(3);
    expect(t.settlement).toBeNull();
    expect(t.settlementParams).toEqual({});
    expect(t.unconfirmed.join(" ")).toMatch(/ONDC_FOOD_PAYMENT_COLLECTOR/);
    expect(t.unconfirmed.join(" ")).toMatch(/ONDC_FINDER_FEE_PERCENT/);
    expect(t.unconfirmed.join(" ")).toMatch(/settlement account/i);
  });

  it("takes the founder's choices once set, and stops flagging them", () => {
    const t = commercialTerms({
      ONDC_FOOD_PAYMENT_COLLECTOR: "BAP",
      ONDC_FINDER_FEE_PERCENT: "4.5",
      ONDC_SETTLEMENT_ACCOUNT_NUMBER: "123456789012",
      ONDC_SETTLEMENT_IFSC: "HDFC0001234",
      ONDC_SETTLEMENT_BENEFICIARY: "Algorithec Private Limited",
      ONDC_STATIC_TERMS_URL: "https://flouna.com/ondc/terms",
    });
    expect(t.foodCollectedBy).toBe("BAP");
    expect(t.finderFeePercent).toBe(4.5);
    expect(t.settlementParams).toEqual({ bank_account_number: "123456789012", bank_code: "HDFC0001234" });
    expect(t.unconfirmed).toEqual([]);
  });

  it("accepts a UPI id instead of a bank account", () => {
    const t = commercialTerms({ ONDC_SETTLEMENT_UPI: "algorithec@hdfcbank", ONDC_SETTLEMENT_BENEFICIARY: "Algorithec Private Limited" });
    expect(t.settlementParams).toEqual({ virtual_payment_address: "algorithec@hdfcbank" });
  });

  it("refuses values that would put the wrong thing on the wire", () => {
    expect(() => commercialTerms({ ONDC_FOOD_PAYMENT_COLLECTOR: "SELLER" })).toThrow(/BAP or BPP/);
    for (const fee of ["abc", "-1", "101", "3.333"]) {
      expect(() => commercialTerms({ ONDC_FINDER_FEE_PERCENT: fee })).toThrow(/finder fee/i);
    }
    expect(() => commercialTerms({ ONDC_SETTLEMENT_ACCOUNT_NUMBER: "12ab", ONDC_SETTLEMENT_IFSC: "HDFC0001234" })).toThrow(/ACCOUNT_NUMBER must be/);
    expect(() => commercialTerms({ ONDC_SETTLEMENT_ACCOUNT_NUMBER: "123456789012", ONDC_SETTLEMENT_IFSC: "HDFC1234" })).toThrow(/IFSC/);
    expect(() => commercialTerms({ ONDC_SETTLEMENT_ACCOUNT_NUMBER: "123456789012" })).toThrow(/IFSC/);
    expect(() => commercialTerms({ ONDC_SETTLEMENT_UPI: "not a upi" })).toThrow(/UPI/);
    expect(() => commercialTerms({ ONDC_STATIC_TERMS_URL: "http://flouna.com/terms" })).toThrow(/https/);
  });

  it("does not accept a settlement account without the name it is held in", () => {
    expect(() => commercialTerms({ ONDC_SETTLEMENT_UPI: "algorithec@hdfcbank" })).toThrow(/beneficiary/i);
  });
});
