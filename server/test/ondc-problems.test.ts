import { describe, expect, it } from "vitest";
import { billReducedProblem, fareChangedProblem, outOfStockProblem, PROBLEM, problemCode } from "../src/modules/ondc/problems.js";

// From the review on #81: a problem on an ONDC order or ride was shown to the
// customer in English whatever their language. Each one customers see now
// comes with a code the app translates; anything else stays as it was.

describe("problems as codes the app translates", () => {
  it("gives every listed problem its code", () => {
    for (const [code, text] of Object.entries(PROBLEM)) expect(problemCode(text)).toEqual({ code });
  });

  it("reads the values back out of the problems that carry them", () => {
    expect(problemCode(fareChangedProblem(14600, 17850))).toEqual({ code: "fareChanged", params: { from: "146", to: "178.5" } });
    expect(problemCode(billReducedProblem(47500, 38000))).toEqual({ code: "billReduced", params: { from: "475", to: "380" } });
    expect(problemCode(outOfStockProblem(["Farmhouse Pizza", "Fresh Tomato"]))).toEqual({ code: "outOfStock", params: { items: "Farmhouse Pizza, Fresh Tomato" } });
  });

  it("leaves anything else to be shown as it is", () => {
    expect(problemCode("The seller's quote has no valid total")).toBeNull();
    expect(problemCode(null)).toBeNull();
  });
});
