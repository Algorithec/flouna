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
    // Unpublished terms are not stated, and with no GSTIN no food order can be placed.
    expect(t.staticTerms).toBeNull();
    expect(t.gstin).toBeNull();
    expect(t.unconfirmed.join(" ")).toMatch(/ONDC_BAP_GSTIN/);
    // Ride searches still name a terms link; the bare domain answers 404 there.
    expect(t.staticTermsUrl).toBe("https://www.flouna.com/ondc/terms");
  });

  it("takes the founder's choices once set, and stops flagging them", () => {
    const t = commercialTerms({
      ONDC_FOOD_PAYMENT_COLLECTOR: "BAP",
      ONDC_FINDER_FEE_PERCENT: "4.5",
      ONDC_SETTLEMENT_ACCOUNT_NUMBER: "123456789012",
      ONDC_SETTLEMENT_IFSC: "HDFC0001234",
      ONDC_SETTLEMENT_BENEFICIARY: "Algorithec Private Limited",
      ONDC_STATIC_TERMS_URL: "https://flouna.com/ondc/terms",
      ONDC_STATIC_TERMS_EFFECTIVE_DATE: "2026-11-01",
      ONDC_BAP_GSTIN: "00algth0000a1z0",
    });
    expect(t.foodCollectedBy).toBe("BAP");
    expect(t.staticTerms).toEqual({ url: "https://flouna.com/ondc/terms", effectiveDate: "2026-11-01T00:00:00.000Z" });
    expect(t.gstin).toBe("00ALGTH0000A1Z0");
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
    expect(() => commercialTerms({ ONDC_STATIC_TERMS_URL: "https://flouna.com/terms" })).toThrow(/EFFECTIVE_DATE/);
    for (const date of ["01-11-2026", "2026-11-1", "2026-02-31", "2026-13-01"]) {
      expect(() => commercialTerms({ ONDC_STATIC_TERMS_URL: "https://flouna.com/terms", ONDC_STATIC_TERMS_EFFECTIVE_DATE: date })).toThrow(/EFFECTIVE_DATE/);
    }
    for (const gstin of ["GSTIN1234567890", "29AAECN5025F1Z", "29AAECN5025F0ZK"]) {
      expect(() => commercialTerms({ ONDC_BAP_GSTIN: gstin })).toThrow(/GSTIN/);
    }
  });

  it("does not accept a settlement account without the name it is held in", () => {
    expect(() => commercialTerms({ ONDC_SETTLEMENT_UPI: "algorithec@hdfcbank" })).toThrow(/beneficiary/i);
  });
});
