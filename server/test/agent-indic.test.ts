import { describe, expect, it } from "vitest";
import { parseInstruction } from "../src/modules/agent/parse.js";

// Instructions in Hinglish, Hindi and Telugu read into the same actions as
// English, with no model needed.

describe("reading Hindi, Hinglish and Telugu instructions", () => {
  it.each([
    // Hinglish
    ["isko cart mein daal do", { kind: "cart.add", target: { by: "last" }, qty: 1 }],
    ["ye add karo", { kind: "cart.add", target: { by: "last" }, qty: 1 }],
    ["doosra wala cart mein daalo", { kind: "cart.add", target: { by: "position", index: 1 }, qty: 1 }],
    ["do plate add karo", { kind: "cart.add", target: { by: "last" }, qty: 2 }],
    ["ek aur daal do", { kind: "cart.add", target: { by: "last" }, qty: 1 }],
    ["isko hata do", { kind: "cart.remove", target: { by: "last" } }],
    ["mera cart dikhao", { kind: "cart.show" }],
    ["cart khali karo", { kind: "cart.clear" }],
    ["4 logon ka group order banao, sirf mere liye", { kind: "group.create", members: 4, withMyItems: true }],
    ["char logon ke liye group order banao", { kind: "group.create", members: 4, withMyItems: false }],
    ["doosra wala", { kind: "select", index: 1, pick: null }],
    ["sabse sasta", { kind: "select", index: null, pick: "cheapest" }],
    ["book kar do", { kind: "ride.book" }],
    ["4 logon ke liye ride book karo", { kind: "ride.group", members: 4 }],
    ["sab saath", { kind: "ride.group_mode", mode: "shared" }],
    ["sirf meri ride", { kind: "ride.group_mode", mode: "mine" }],
    ["haan", { kind: "confirm" }],
    ["theek hai", { kind: "confirm" }],
    ["nahi", { kind: "cancel" }],
    ["rehne do", { kind: "cancel" }],
    // Hindi
    ["इसे कार्ट में डालो", { kind: "cart.add", target: { by: "last" }, qty: 1 }],
    ["दूसरा वाला कार्ट में डाल दो", { kind: "cart.add", target: { by: "position", index: 1 }, qty: 1 }],
    ["दो प्लेट जोड़ो", { kind: "cart.add", target: { by: "last" }, qty: 2 }],
    ["इसे हटा दो", { kind: "cart.remove", target: { by: "last" } }],
    ["कार्ट दिखाओ", { kind: "cart.show" }],
    ["कार्ट खाली करो", { kind: "cart.clear" }],
    ["4 लोगों का ग्रुप ऑर्डर बनाओ, सिर्फ़ मेरे लिए", { kind: "group.create", members: 4, withMyItems: true }],
    ["सबसे सस्ता", { kind: "select", index: null, pick: "cheapest" }],
    ["बुक करो", { kind: "ride.book" }],
    ["हाँ", { kind: "confirm" }],
    ["नहीं", { kind: "cancel" }],
    // Telugu
    ["దీన్ని కార్ట్‌లో వేయి", { kind: "cart.add", target: { by: "last" }, qty: 1 }],
    ["రెండోది కార్ట్‌లో పెట్టు", { kind: "cart.add", target: { by: "position", index: 1 }, qty: 1 }],
    ["రెండు ప్లేట్లు వేయండి", { kind: "cart.add", target: { by: "last" }, qty: 2 }],
    ["దీన్ని తీసేయి", { kind: "cart.remove", target: { by: "last" } }],
    ["కార్ట్ చూపించు", { kind: "cart.show" }],
    ["కార్ట్ ఖాళీ చేయి", { kind: "cart.clear" }],
    ["4 మంది కోసం గ్రూప్ ఆర్డర్ చేయి, నా కోసం మాత్రమే", { kind: "group.create", members: 4, withMyItems: true }],
    ["రెండోది", { kind: "select", index: 1, pick: null }],
    ["బుక్ చేయండి", { kind: "ride.book" }],
    ["అవును", { kind: "confirm" }],
    ["వద్దు", { kind: "cancel" }],
  ])("%s", (text, action) => {
    expect(parseInstruction(text)).toEqual(action);
  });

  it.each([
    "biryani chahiye 300 ke andar",
    "mujhe pizza khana hai",
    "charminar jaane ke liye cab",
    "बिरयानी दिखाओ",
    "నాకు బిర్యానీ కావాలి",
    "mera order cancel karo",
  ])("%s goes to search, not an action", (text) => {
    expect(parseInstruction(text)).toBeNull();
  });

  it("keeps English meanings exact", () => {
    expect(parseInstruction("remove the biryani")).toEqual({ kind: "cart.remove", target: { by: "name", text: "biryani" } });
  });
});
