// Ride training data for the fine-tuned intent model, labelled by the rules.
//
// The first fine-tune was taught a schema without the ride limits (budget,
// pickup wait) and without the food delivery limit, so it cannot return them.
// This writes rows in the same chat format as model/gen_data.py, with two
// differences that matter:
//
//   - The system prompt is the one the server actually sends to Ollama
//     (SYSTEM_PROMPT + JSON_SHAPE from the built prompt.ts), so the model is
//     trained on the instructions it will be given.
//   - Every label comes from the rule engine, which scores 100% on the tuned
//     set, and a row is kept only if the rules are confident AND their reading
//     matches what the template meant. A rule mistake is dropped, never taught.
//
// Neither eval set is used: any message that appears in the tuned or the
// held-out set is skipped, so both stay a fair test of the trained model.
//
//   npm run build
//   node scripts/gen-ride-training.mjs                 2400 train + 240 eval
//   node scripts/gen-ride-training.mjs --train 4000 --eval 400 --out ../model
//
// Output: ride_train.jsonl and ride_eval.jsonl in --out (default ../model).

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
};
const N_TRAIN = Number(arg("train", 2400));
const N_EVAL = Number(arg("eval", 240));
const OUT = resolve(HERE, arg("out", "../../model"));
// --disagreements <file>: also write every sentence the rules read differently
// from its template, which is where to look for rule gaps.
const DISAGREEMENTS = arg("disagreements", null);
const disagreements = [];
const SEED = Number(arg("seed", 7));

const dist = resolve(HERE, "../dist/modules/chat/llm");
if (!existsSync(dist)) {
  console.error("No dist/. Run `npm run build` first.");
  process.exit(2);
}
const { readWithConfidence } = await import(`file://${dist}/demo.js`);
const { SYSTEM_PROMPT, JSON_SHAPE } = await import(`file://${dist}/prompt.js`);
const SYSTEM = `${SYSTEM_PROMPT}\n\n${JSON_SHAPE}`;

// ---- a seeded random, so the same command writes the same file ----
let state = SEED >>> 0 || 1;
const rand = () => ((state = (state * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const pick = (xs) => xs[Math.floor(rand() * xs.length)];
const chance = (p) => rand() < p;

// ---- vocabulary ----
const PLACES = [
  "Gachibowli", "Ameerpet", "Madhapur", "Kondapur", "Kukatpally", "Hitech City", "Banjara Hills",
  "Jubilee Hills", "Begumpet", "Secunderabad", "Charminar", "Miyapur", "Dilsukhnagar", "Uppal",
  "LB Nagar", "Mehdipatnam", "Tolichowki", "Manikonda", "Kompally", "Shamshabad", "Abids",
  "Koti", "Somajiguda", "Panjagutta", "Lingampally", "Nampally", "Kothapet", "Attapur",
  "Financial District", "Nanakramguda", "Raidurg", "Bachupally", "Nizampet", "Ramoji Film City",
  "the airport", "the railway station", "Inorbit Mall", "Forum Mall",
];
const VEHICLES = {
  bike: ["bike", "bike taxi"],
  auto: ["auto", "rickshaw"],
  cab: ["cab", "taxi"],
  any: ["ride"],
};
const PRIORITY_WORDS = {
  price: ["cheapest", "cheap", "affordable", "sasta", "takkuva"],
  speed: ["fastest", "quick", "urgent", "jaldi", "tondaraga"],
  rating: ["best", "top rated"],
};
const TIMES = [
  ["at 10pm", "22:00"], ["at 9pm", "21:00"], ["at 7am", "07:00"], ["at 6:30am", "06:30"],
  ["tonight at 9", "21:00"], ["at 11pm", "23:00"], ["at 8am", "08:00"], ["at 5pm", "17:00"],
];

const budgetPhrase = (rupees) =>
  pick([
    `under ${rupees}`, `under ₹${rupees}`, `below ${rupees}`, `within ${rupees} rupees`,
    `max ₹${rupees}`, `${rupees} tak`, `${rupees} ke andar`, `${rupees} lopala`, `budget ${rupees}`,
  ]);
const pickupPhrase = (mins) =>
  pick([
    `pickup within ${mins} mins`, `pickup in ${mins} minutes`,
    `don't want to wait more than ${mins} minutes`, `pick me up in ${mins} mins`,
  ]);

// ---- one request: what it means, and one way of saying it ----
function makeRide() {
  const vehicle = pick(["bike", "auto", "cab", "cab", "auto", "any"]);
  const vword = pick(VEHICLES[vehicle]);
  const drop = pick(PLACES);
  const withPickup = chance(0.18);
  const pickup = withPickup ? pick(PLACES.filter((p) => p !== drop && !p.startsWith("the "))) : null;
  const priority = chance(0.35) ? pick(["price", "speed", "rating"]) : "balanced";
  const pword = priority === "balanced" ? "" : pick(PRIORITY_WORDS[priority]);
  const budget = chance(0.3) ? pick([60, 80, 100, 120, 150, 180, 200, 250, 300, 350, 400, 500, 600]) : null;
  const wait = chance(0.2) ? pick([3, 4, 5, 7, 8, 10, 12, 15]) : null;
  const sched = !wait && chance(0.15) ? pick(TIMES) : null;

  const article = /^[aeiou]/.test(vword) ? "an" : "a";
  const english = () => {
    const from = pickup ? ` from ${pickup}` : "";
    // A priority word goes where a person would put it: before the vehicle
    // ("cheapest cab", "book a quick auto") or as an aside after the place.
    const an = (w) => (/^[aeiou]/.test(w) ? "an" : "a");
    const lead = pword
      ? pick([
          `${pword} ${vword}`,
          `book ${an(pword)} ${pword} ${vword}`,
          `need ${an(pword)} ${pword} ${vword}`,
        ])
      : pick([`book ${article} ${vword}`, `get me ${article} ${vword}`, `need ${article} ${vword}`, `${vword}`]);
    let s = `${lead}${from} to ${drop}`;
    if (sched) s += ` ${sched[0]}`;
    if (budget) s += `${chance(0.5) ? "," : ""} ${budgetPhrase(budget)}`;
    if (wait) s += `, ${pickupPhrase(wait)}`;
    return s;
  };
  const hinglish = () => {
    let s = pick([`${drop} jana hai ${vword} chahiye`, `${drop} ke liye ${vword} book karo`, `${vword} book karo ${drop} tak`]);
    if (pword) s = `${pword} ${s}`;
    if (budget) s += ` ${budget} tak`;
    return s;
  };
  const telugu = () => {
    let s = pick([`${drop} ki ${vword} kavali`, `${drop} velali ${vword} book cheyyi`]);
    if (pword) s = `${pword} ${s}`;
    if (budget) s += ` ${budget} lopala`;
    return s;
  };
  // Mixed scripts only where the place reads naturally without "the".
  const local = !drop.startsWith("the ") && !pickup && !sched && !wait;
  const style = local ? pick(["en", "en", "en", "hi", "te"]) : "en";
  let text = style === "hi" ? hinglish() : style === "te" ? telugu() : english();
  if (chance(0.25)) text = text.toLowerCase();

  return {
    text: text.replace(/\s+/g, " ").trim(),
    want: {
      pickup,
      drop,
      vehicle,
      budgetPaise: budget ? budget * 100 : null,
      maxPickupMinutes: wait,
      priority,
      scheduleAt: sched ? sched[1] : null,
    },
  };
}

// Food rows carrying the delivery limit the first schema also left out.
const DISHES = ["biryani", "pizza", "dosa", "burger", "paneer tikka", "noodles", "thali", "shawarma", "idli", "momos"];
function makeFoodLimit() {
  const item = pick(DISHES);
  const eta = pick([20, 25, 30, 35, 40, 45]);
  const budget = chance(0.5) ? pick([150, 200, 250, 300, 400]) : null;
  let text = `${pick(["order", "get me", "I want", ""])} ${item} within ${eta} minutes`;
  if (budget) text += ` ${pick([`under ₹${budget}`, `under ${budget}`, `${budget} tak`, `below ${budget}`])}`;
  if (chance(0.25)) text = text.toLowerCase();
  return { text: text.replace(/\s+/g, " ").trim(), food: { item, maxEtaMinutes: eta, budgetPaise: budget ? budget * 100 : null } };
}

// ---- what is off limits: both eval sets ----
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9₹]+/g, " ").trim();
const held = new Set();
for (const f of ["intent-eval.jsonl", "intent-eval-holdout.jsonl"]) {
  for (const line of readFileSync(resolve(HERE, "../test/fixtures", f), "utf8").split("\n")) {
    if (line.trim()) held.add(norm(JSON.parse(line).message));
  }
}

const sameText = (a, b) => (a ?? "").toLowerCase() === (b ?? "").toLowerCase();
function rideAgrees(got, want) {
  return (
    got &&
    sameText(got.drop, want.drop) &&
    sameText(got.pickup, want.pickup) &&
    got.vehicle === want.vehicle &&
    got.budgetPaise === want.budgetPaise &&
    got.maxPickupMinutes === want.maxPickupMinutes &&
    got.priority === want.priority &&
    got.scheduleAt === want.scheduleAt
  );
}

function row(user, intent) {
  return {
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: user },
      { role: "assistant", content: JSON.stringify(intent) },
    ],
  };
}

const seen = new Set();
const rows = [];
const stats = { tried: 0, kept: 0, doubtful: 0, disagreed: 0, heldOut: 0, duplicate: 0 };
const target = N_TRAIN + N_EVAL;
while (rows.length < target && stats.tried < target * 40) {
  stats.tried++;
  const isFood = chance(0.15);
  const ex = isFood ? makeFoodLimit() : makeRide();
  const key = norm(ex.text);
  if (held.has(key)) { stats.heldOut++; continue; }
  if (seen.has(key)) { stats.duplicate++; continue; }
  const r = readWithConfidence(ex.text);
  if (!r.confident) { stats.doubtful++; continue; }
  let ok;
  if (isFood) {
    const f = r.intent.food;
    ok = r.intent.domain === "food" && f && f.maxEtaMinutes === ex.food.maxEtaMinutes &&
      f.budgetPaise === ex.food.budgetPaise && f.item.toLowerCase().includes(ex.food.item.split(" ")[0].replace(/s$/, ""));
  } else {
    ok = r.intent.domain === "ride" && rideAgrees(r.intent.ride, ex.want);
  }
  if (!ok) {
    stats.disagreed++;
    if (DISAGREEMENTS) {
      disagreements.push({ text: ex.text, want: isFood ? ex.food : ex.want, got: isFood ? r.intent.food : r.intent.ride, domain: r.intent.domain });
    }
    continue;
  }
  seen.add(key);
  // The label is the rules' reading with the intended place names, which
  // differ only in letter case.
  const intent = isFood ? r.intent : { ...r.intent, ride: { ...r.intent.ride, drop: ex.want.drop, pickup: ex.want.pickup } };
  rows.push(row(ex.text, intent));
  stats.kept++;
}

// Shuffle, then split so eval never shares a sentence with train.
for (let i = rows.length - 1; i > 0; i--) {
  const j = Math.floor(rand() * (i + 1));
  [rows[i], rows[j]] = [rows[j], rows[i]];
}
const evalRows = rows.slice(0, N_EVAL);
const trainRows = rows.slice(N_EVAL);
const write = (name, rs) => writeFileSync(resolve(OUT, name), rs.map((r) => JSON.stringify(r)).join("\n") + "\n");
write("ride_train.jsonl", trainRows);
write("ride_eval.jsonl", evalRows);
if (DISAGREEMENTS) {
  writeFileSync(resolve(DISAGREEMENTS), disagreements.map((d) => JSON.stringify(d)).join("\n") + "\n");
  console.log(`wrote ${disagreements.length} disagreements to ${DISAGREEMENTS}`);
}

// ---- what was written ----
const fields = { budget: 0, wait: 0, schedule: 0, pickup: 0, priority: 0, food: 0, hinglish: 0, telugu: 0 };
for (const r of rows) {
  const u = r.messages[1].content;
  const out = JSON.parse(r.messages[2].content);
  if (out.domain === "food") { fields.food++; continue; }
  if (out.ride.budgetPaise) fields.budget++;
  if (out.ride.maxPickupMinutes) fields.wait++;
  if (out.ride.scheduleAt) fields.schedule++;
  if (out.ride.pickup) fields.pickup++;
  if (out.ride.priority !== "balanced") fields.priority++;
  if (/jana hai|ke liye|karo|chahiye/.test(u)) fields.hinglish++;
  if (/kavali|velali|cheyyi|lopala/.test(u)) fields.telugu++;
}
console.log(`wrote ${trainRows.length} train and ${evalRows.length} eval rows to ${OUT}`);
console.log(`generated ${stats.tried}: kept ${stats.kept}, rules unsure ${stats.doubtful}, rules disagreed ${stats.disagreed}, in an eval set ${stats.heldOut}, duplicate ${stats.duplicate}`);
console.log(`rows with: ${Object.entries(fields).map(([k, v]) => `${k} ${v}`).join(", ")}`);
if (rows.length < target) {
  console.error(`only ${rows.length} of ${target} rows could be made`);
  process.exitCode = 1;
}
