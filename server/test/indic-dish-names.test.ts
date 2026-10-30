import { describe, expect, it } from "vitest";
import { toEnglishTerms } from "../src/lib/indicTerms.js";
import { readWithConfidence } from "../src/modules/chat/llm/demo.js";
import { authedAgent } from "./helpers.js";

// The app is offered in Hindi, Marathi, Kannada, Tamil and Telugu, but its
// catalogue and its chat's reader only knew dish names in English. "बिरयानी"
// in the search box showed the whole menu as a substitute, and "₹300 లోపు
// పిజ్జా ఆర్డర్ చేయి" in the chat was refused as out of scope.

describe("dish and ride words in Indian scripts", () => {
  it("reads each script's word as the catalogue's English word", () => {
    expect(toEnglishTerms("बिरयानी")).toBe("biryani");
    expect(toEnglishTerms("पिझ्झा")).toBe("pizza"); // Marathi
    expect(toEnglishTerms("ಮಸಾಲಾ ದೋಸೆ")).toBe("ಮಸಾಲಾ dosa");
    expect(toEnglishTerms("பிரியாணி")).toBe("biryani");
    expect(toEnglishTerms("వెజ్ థాలీ")).toBe("veg thali");
    expect(toEnglishTerms("క్యాబ్")).toBe("cab");
  });

  it("takes the spellings keyboards produce, and words with a suffix", () => {
    // With and without the nukta, which phones type both ways.
    expect(toEnglishTerms("पिज़्ज़ा")).toBe("pizza");
    expect(toEnglishTerms("पिज्जा")).toBe("pizza");
    // A Telugu plural, a sentence-final mark.
    expect(toEnglishTerms("బిర్యానీలు")).toBe("biryani");
    expect(toEnglishTerms("पिज्जा।")).toBe("pizza");
    // Case endings joined to the noun, in each language that joins them.
    expect(toEnglishTerms("पिझ्झाची")).toBe("pizza"); // Marathi
    expect(toEnglishTerms("ಬಿರಿಯಾನಿಯನ್ನು")).toBe("biryani"); // Kannada
    expect(toEnglishTerms("பீட்சாவை")).toBe("pizza"); // Tamil
    expect(toEnglishTerms("బిర్యానీని")).toBe("biryani"); // Telugu
    // The commoner long-vowel spelling, and plurals written as their own word.
    expect(toEnglishTerms("ಸಮೋಸಾ")).toBe("samosa");
    expect(toEnglishTerms("मोमोज़")).toBe("momo");
  });

  it("leaves a word alone that only begins with a dish's letters", () => {
    // వడ్డీ (interest) starts with the letters of వడ (vada), mid-syllable.
    expect(toEnglishTerms("వడ్డీ")).toBe("వడ్డీ");
    // Cucumber is not a dosa.
    expect(toEnglishTerms("దోసకాయ")).toBe("దోసకాయ");
    // Found in review: crab, hailstones, automatic, roller, rider and biker
    // each begin with a listed word and are none of them.
    for (const word of ["केकड़ा", "వడగళ్ళు", "ऑटोमैटिक", "रोलर", "राइडर", "बाइकर"]) {
      expect(toEnglishTerms(word), word).toBe(word);
    }
    expect(toEnglishTerms("biryani under 200")).toBe("biryani under 200");
  });
});

describe("food search in Indian scripts", () => {
  it("finds the dish, and does not call it a correction", async () => {
    const { agent } = await authedAgent();
    for (const typed of ["बिरयानी", "बिर्याणी", "ಬಿರಿಯಾನಿ", "பிரியாணி", "బిర్యానీ"]) {
      const res = await agent.get(`/api/food/search?q=${encodeURIComponent(typed)}`).expect(200);
      expect(res.body.substituted, typed).toBe(false);
      expect(res.body.searchedFor, typed).toBeUndefined();
      expect(res.body.quotes.length, typed).toBeGreaterThan(0);
      for (const q of res.body.quotes) expect(q.name.toLowerCase()).toContain("biryani");
    }
  });

  it("does not turn a search for crab into cake", async () => {
    const { agent } = await authedAgent();
    const res = await agent.get(`/api/food/search?q=${encodeURIComponent("केकड़ा")}`).expect(200);
    // Nothing on the menu is crab, and the search says so rather than
    // presenting cake as a match.
    expect(res.body.substituted).toBe(true);
  });
});

describe("the chat's reader in Indian scripts", () => {
  it("reads the same pizza order, limit included, in all six languages", () => {
    for (const message of [
      "Order a pizza under ₹300",
      "₹300 से कम में पिज़्ज़ा ऑर्डर करें",
      "₹300 च्या आत पिझ्झा ऑर्डर करा",
      "₹300 ಒಳಗೆ ಪಿಜ್ಜಾ ಆರ್ಡರ್ ಮಾಡಿ",
      "₹300 க்குள் பீட்சா ஆர்டர் செய்",
      "₹300 లోపు పిజ్జా ఆర్డర్ చేయి",
    ]) {
      const { intent } = readWithConfidence(message);
      expect(intent.domain, message).toBe("food");
      expect(intent.food, message).toMatchObject({ item: "pizza", budgetPaise: 30000 });
    }
  });

  it("reads a cab request as a ride and a veg thali as vegetarian", () => {
    for (const message of ["अभी सबसे सस्ती कैब ढूँढो", "ಈಗ ಅತ್ಯಂತ ಅಗ್ಗದ ಕ್ಯಾಬ್ ಹುಡುಕಿ", "ఇప్పుడు అతి చౌకైన క్యాబ్ వెతుకు"]) {
      expect(readWithConfidence(message).intent.domain, message).toBe("ride");
    }
    for (const message of ["जवळची सर्वात चांगली व्हेज थाळी", "அருகில் சிறந்த சைவ தாலி", "దగ్గరలో మంచి వెజ్ థాలీ"]) {
      expect(readWithConfidence(message).intent.food, message).toMatchObject({ item: "thali", dietary: "veg" });
    }
  });
});
