import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { recommendProduct, SHOP_WHY_CODES } from "../src/modules/shop/shop.service.js";

// The reason under a product pick ("Best overall, 4.4★, 2-day delivery, best
// value across sellers") was English for every reader. It now also comes
// fragment by fragment as codes the app translates.

const dictionaries = readFileSync(new URL("../../web/lib/i18n/dictionaries.ts", import.meta.url), "utf8");

/** The app's English for a fragment, read from its dictionary. */
function english(code: string): string {
  const m = dictionaries.match(new RegExp(`"why\\.s\\.${code}": ("(?:[^"\\\\]|\\\\.)*"),`));
  if (!m) throw new Error(`no English for why.s.${code}`);
  return JSON.parse(m[1]!) as string;
}

describe("the reason for a product pick, in the reader's language", () => {
  it("says, fragment by fragment, exactly what the English says", () => {
    let checked = 0;
    for (const priority of ["price", "rating", "speed", "balanced"] as const) {
      for (const query of ["laptop", "earbuds", "shoes", "smartwatch", "phone", "headphones", "backpack"]) {
        const rec = recommendProduct({ query, priority });
        if (!rec) continue;
        const rebuilt = rec.whyParts
          .map((p) => Object.entries(p.params ?? {}).reduce((s, [k, v]) => s.replaceAll(`{${k}}`, v), english(p.code)))
          .join("");
        expect(rebuilt, `${priority} ${query}`).toBe(rec.why);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(15);
  });

  it("has every fragment translated in all six of the app's languages", () => {
    for (const code of SHOP_WHY_CODES) {
      expect(dictionaries.split(`"why.s.${code}":`).length - 1, code).toBe(6);
    }
  });
});
