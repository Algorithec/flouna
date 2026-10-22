import { checkedFeePercent, checkedHttpsUrl } from "./context.js";
import { GSTIN, type StaticTerms } from "./retail.js";

// Flouna's commercial terms on ONDC.
//
// Three of these are the founder's decision, not the code's:
//
//   - Who collects payment for food orders. "BPP" means the seller app takes
//     the customer's money and Flouna handles none of the seller's; "BAP"
//     means Flouna collects and owes each seller its share, which brings
//     settlement duties and the regulation that comes with holding other
//     people's money.
//   - The finder fee: the percentage of each order the seller pays Flouna for
//     bringing the customer. It is stated on every search, and a seller that
//     finds it too high refuses the order (ONDC error 41001).
//   - The account the finder fee is paid into.
//
// Until each is set, the default lets the whole flow run without committing
// the company to a choice it has not made, and `unconfirmed` lists what is
// still a default so the server can say so at boot.

export type CommercialTerms = {
  foodCollectedBy: "BAP" | "BPP";
  finderFeePercent: number;
  /** Where sellers and ride providers pay the finder fee, or null if no account is set. */
  settlement: { beneficiary: string; accountNumber?: string; ifsc?: string; upi?: string } | null;
  /** The same account, as the payment params of an ONDC message. */
  settlementParams: { bank_account_number?: string; bank_code?: string; virtual_payment_address?: string };
  staticTermsUrl: string;
  /** The published static terms food searches state, or null until they are published. */
  staticTerms: StaticTerms | null;
  /** Algorithec's GSTIN, which every food confirm carries; null until it is set. */
  gstin: string | null;
  delayInterestPercent: number;
  /** Terms still on their default, in words fit for a boot warning. */
  unconfirmed: string[];
};

type Env = Record<string, string | undefined>;

/** The finder fee in ONDC's certified buyer flows; a placeholder until the founder sets one. */
const DEFAULT_FINDER_FEE = 3;

export function commercialTerms(e: Env = process.env): CommercialTerms {
  const unconfirmed: string[] = [];

  const collector = e.ONDC_FOOD_PAYMENT_COLLECTOR?.trim();
  if (collector && collector !== "BAP" && collector !== "BPP") {
    throw new Error(`ONDC_FOOD_PAYMENT_COLLECTOR must be BAP or BPP, got ${collector}`);
  }
  if (!collector) {
    unconfirmed.push("ONDC_FOOD_PAYMENT_COLLECTOR is unset, so sellers collect for food orders (BPP)");
  }

  let finderFeePercent = DEFAULT_FINDER_FEE;
  const fee = e.ONDC_FINDER_FEE_PERCENT?.trim();
  if (fee) {
    const n = Number(fee);
    try {
      finderFeePercent = checkedFeePercent(n);
    } catch (err) {
      throw new Error(`ONDC_FINDER_FEE_PERCENT: ${(err as Error).message}`);
    }
  } else {
    unconfirmed.push(`ONDC_FINDER_FEE_PERCENT is unset, so searches state a ${DEFAULT_FINDER_FEE}% finder fee`);
  }

  const accountNumber = e.ONDC_SETTLEMENT_ACCOUNT_NUMBER?.trim() || undefined;
  const ifsc = e.ONDC_SETTLEMENT_IFSC?.trim().toUpperCase() || undefined;
  const upi = e.ONDC_SETTLEMENT_UPI?.trim() || undefined;
  const beneficiary = e.ONDC_SETTLEMENT_BENEFICIARY?.trim() || undefined;
  if (accountNumber && !/^\d{9,18}$/.test(accountNumber)) {
    throw new Error("ONDC_SETTLEMENT_ACCOUNT_NUMBER must be 9 to 18 digits");
  }
  if (accountNumber && !ifsc) throw new Error("ONDC_SETTLEMENT_ACCOUNT_NUMBER needs ONDC_SETTLEMENT_IFSC alongside it");
  if (ifsc && !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc)) throw new Error(`ONDC_SETTLEMENT_IFSC is not an IFSC code: ${ifsc}`);
  if (upi && !/^[a-zA-Z0-9._-]{2,256}@[a-zA-Z]{2,64}$/.test(upi)) throw new Error(`ONDC_SETTLEMENT_UPI is not a UPI id: ${upi}`);
  const hasAccount = Boolean(accountNumber || upi);
  if (hasAccount && !beneficiary) {
    throw new Error("ONDC_SETTLEMENT_BENEFICIARY, the name the account is held in, is needed with a settlement account");
  }
  if (!hasAccount) {
    unconfirmed.push("No ONDC settlement account is set, so sellers and ride providers have nowhere to pay the finder fee");
  }

  const staticTermsUrl = checkedHttpsUrl(e.ONDC_STATIC_TERMS_URL?.trim() || "https://flouna.com/ondc/terms", "ONDC_STATIC_TERMS_URL");
  if (!e.ONDC_STATIC_TERMS_URL) {
    unconfirmed.push(`ONDC_STATIC_TERMS_URL is unset, so ride searches point at ${staticTermsUrl}, which must be published first`);
  }
  // Food searches state the terms with the date they apply from, so the two
  // are set together. Unpublished terms are not stated at all.
  const effective = e.ONDC_STATIC_TERMS_EFFECTIVE_DATE?.trim();
  if (effective && !/^\d{4}-\d{2}-\d{2}$/.test(effective)) {
    throw new Error(`ONDC_STATIC_TERMS_EFFECTIVE_DATE must be a date such as 2026-11-01, got ${effective}`);
  }
  // 2026-02-31 matches the pattern; only a real date survives the round trip.
  const day = effective ? new Date(`${effective}T00:00:00.000Z`) : null;
  if (effective && (Number.isNaN(day!.getTime()) || day!.toISOString().slice(0, 10) !== effective)) {
    throw new Error(`ONDC_STATIC_TERMS_EFFECTIVE_DATE is not a real date: ${effective}`);
  }
  if (e.ONDC_STATIC_TERMS_URL && !effective) {
    throw new Error("ONDC_STATIC_TERMS_URL needs ONDC_STATIC_TERMS_EFFECTIVE_DATE, the date the terms apply from");
  }
  const staticTerms = e.ONDC_STATIC_TERMS_URL && effective ? { url: staticTermsUrl, effectiveDate: `${effective}T00:00:00.000Z` } : null;

  const gstin = e.ONDC_BAP_GSTIN?.trim().toUpperCase() || null;
  if (gstin && !GSTIN.test(gstin)) throw new Error(`ONDC_BAP_GSTIN is not a GSTIN: ${gstin}`);
  if (!gstin) {
    unconfirmed.push("ONDC_BAP_GSTIN is unset, so food orders cannot be placed: every confirm must carry Algorithec's GSTIN");
  }

  return {
    foodCollectedBy: (collector as "BAP" | "BPP" | undefined) ?? "BPP",
    finderFeePercent,
    settlement: hasAccount ? { beneficiary: beneficiary!, accountNumber, ifsc, upi } : null,
    settlementParams: accountNumber
      ? { bank_account_number: accountNumber, bank_code: ifsc }
      : upi
        ? { virtual_payment_address: upi }
        : {},
    staticTermsUrl,
    staticTerms,
    gstin,
    delayInterestPercent: 5,
    unconfirmed,
  };
}
