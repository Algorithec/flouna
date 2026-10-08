import { describe, expect, it } from "vitest";
import { DemoProvider } from "../src/modules/chat/llm/demo.js";

// The destination, exactly.
//
// The eval set matches strings by inclusion, which is right for free text but
// hid this: "to miyapur, 200 lopala" was read as the destination
// "miyapur, 200 lopala", and "cheap Charminar jana hai" as "cheap Charminar".
// Both contain the place, so both scored as right, and the geocoder was then
// asked for a place that does not exist. Found by generating ride training
// data and checking the rules' reading against what each sentence meant.

const read = async (m: string) => (await new DemoProvider().extractIntent(m)).ride;

describe("the destination is the place and nothing else", () => {
  it.each([
    ["get me an auto to miyapur, 200 lopala", "miyapur"],
    ["cab to Kondapur, 300 ke andar", "Kondapur"],
    ["bike to Madhapur, 150 tak", "Madhapur"],
    ["cab to Uppal 400 tak", "Uppal"],
    ["cheap Charminar jana hai auto chahiye", "Charminar"],
    ["quick Kothapet velali taxi book cheyyi", "Kothapet"],
    ["affordable Inorbit Mall ki auto kavali 200 lopala", "Inorbit Mall"],
    ["sasta Ameerpet ke liye bike book karo", "Ameerpet"],
    ["jaldi Begumpet jana hai cab chahiye", "Begumpet"],
    ["top rated Forum Mall ki bike taxi kavali", "Forum Mall"],
    ["top rated Ameerpet ki taxi kavali", "Ameerpet"],
    ["Hill Top ki auto kavali", "Hill Top"],
  ])("%s", async (message, drop) => {
    expect((await read(message))?.drop).toBe(drop);
  });

  it.each([
    ["cab to Plot 4, 2nd Cross Road", "Plot 4, 2nd Cross Road"],
    ["auto to Road No. 3, 12th Main", "Road No. 3, 12th Main"],
  ])("keeps the numbers in an address: %s", async (message, drop) => {
    expect((await read(message))?.drop).toBe(drop);
  });

  it("keeps a place whose name holds a word that is also a priority", async () => {
    // "Best" is a priority word, but not here.
    expect((await read("cab to Best Western Ashoka"))?.drop).toBe("Best Western Ashoka");
  });
});
