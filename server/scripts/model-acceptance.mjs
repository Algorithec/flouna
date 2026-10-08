// Whether a trained model may help answer customers, in one command.
//
//   npm run build
//   node --env-file=.env scripts/model-acceptance.mjs --model flouna
//   node --env-file=.env scripts/model-acceptance.mjs --model flouna --url http://10.0.0.5:11434
//
// Runs the model through Ollama on both eval sets, beside the rules, and
// scores three ways of answering: rules alone (production today), the model
// alone, and hybrid routing (the rules when they are sure, the model when they
// doubt). Anything slower than the production timeout is counted as a timeout.
//
// Prints GO only when hybrid beats the rules on the held-out set, is no worse
// on the tuned set, and the model never leaks its instructions. Exits 0 for
// GO and 1 for NO GO. The held-out set is reported as totals only, never case
// by case, so it stays a fair test.
//
// GO means: switch the model on as LLM_WATCHER first and read what it does on
// real traffic. HYBRID_ROUTING comes after that, not instead of it.

import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { scoreSet, verdict } from "./acceptance-lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
};
const MODEL = arg("model", null);
if (!MODEL) {
  console.error("usage: node --env-file=.env scripts/model-acceptance.mjs --model <ollama model> [--url http://localhost:11434]");
  process.exit(2);
}
const URL_ = arg("url", "http://localhost:11434");
// What production waits before falling back. The run itself waits longer, so
// a slow model is measured rather than cut off, and then judged against this.
const PRODUCTION_TIMEOUT_MS = Number(arg("production-timeout", 4000));
const RUN_TIMEOUT_MS = Number(arg("run-timeout", 60000));

// Settings must be in place before the built code reads them. No paid
// provider is reachable from this run.
Object.assign(process.env, {
  LLM_PROVIDER: "ollama",
  OLLAMA_URL: URL_,
  OLLAMA_MODEL: MODEL,
  LLM_TIMEOUT_MS: String(RUN_TIMEOUT_MS),
  ANTHROPIC_API_KEY: "",
  DEEPSEEK_API_KEY: "",
  GOOGLE_AI_API_KEY: "",
  NVIDIA_API_KEY: "",
  LLM_WATCHER: "",
});

const dist = resolve(HERE, "../dist/modules/chat/llm");
if (!existsSync(dist)) {
  console.error("No dist/. Run `npm run build` first.");
  process.exit(2);
}
const { OllamaProvider } = await import(`file://${dist}/ollama.js`);
const { readWithConfidence } = await import(`file://${dist}/demo.js`);
const model = new OllamaProvider();

// Is the model there at all, before spending minutes on it.
try {
  const tags = await (await fetch(`${URL_.replace(/\/+$/, "")}/api/tags`)).json();
  const names = (tags.models ?? []).map((m) => m.name);
  if (!names.some((n) => n === MODEL || n === `${MODEL}:latest`)) {
    console.error(`Ollama at ${URL_} has no model "${MODEL}". It has: ${names.join(", ") || "nothing"}`);
    process.exit(2);
  }
} catch (err) {
  console.error(`Cannot reach Ollama at ${URL_}: ${err instanceof Error ? err.message : err}`);
  process.exit(2);
}

const load = (file) =>
  readFileSync(resolve(HERE, "../test/fixtures", file), "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));

async function run(cases, label) {
  const rules = [];
  const modelReadings = [];
  let n = 0;
  for (const c of cases) {
    const r = readWithConfidence(c.message);
    rules.push({ intent: r.intent, confident: r.confident });
    const t0 = Date.now();
    try {
      modelReadings.push({ intent: await model.extractIntent(c.message), ms: Date.now() - t0 });
    } catch (err) {
      modelReadings.push({ error: String(err instanceof Error ? err.message : err), ms: Date.now() - t0 });
    }
    if (++n % 10 === 0) process.stderr.write(`  ${label}: ${n}/${cases.length}\r`);
  }
  process.stderr.write(" ".repeat(40) + "\r");
  return scoreSet(cases, { rules, model: modelReadings, timeoutMs: PRODUCTION_TIMEOUT_MS });
}

const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : "n/a");
const LIMIT_FIELDS = [
  "domain",
  "ride.drop",
  "ride.vehicle",
  "ride.pickup",
  "ride.budgetPaise",
  "ride.maxPickupMinutes",
  "ride.scheduleAt",
  "ride.priority",
  "food.item",
  "food.budgetPaise",
  "food.maxEtaMinutes",
  "food.priority",
];

function report(name, s) {
  console.log(`\n${name} (${s.total} cases)`);
  console.log(`  fully right   rules ${pct(s.rules.right, s.total)}   model ${pct(s.model.right, s.total)}   hybrid ${pct(s.hybrid.right, s.total)}`);
  console.log(`  domain        rules ${pct(s.rules.domainRight, s.total)}   model ${pct(s.model.domainRight, s.total)}   hybrid ${pct(s.hybrid.domainRight, s.total)}`);
  console.log(
    `  model         p50 ${s.model.p50}ms  p95 ${s.model.p95}ms  errors ${s.model.errors}  slower than ${PRODUCTION_TIMEOUT_MS}ms ${s.model.timeouts}  leaks ${s.model.leaks}`,
  );
  console.log(`  hybrid asked the model on ${s.hybrid.modelCalls} of ${s.total} messages; the rest were answered in under a millisecond`);
  console.log("  field                    rules     model     hybrid");
  for (const f of LIMIT_FIELDS) {
    const r = s.rules.fields[f];
    if (!r) continue;
    const m = s.model.fields[f];
    const h = s.hybrid.fields[f];
    const cell = (x) => `${pct(x.ok, x.total).padStart(6)} ${`(${x.ok}/${x.total})`.padEnd(7)}`;
    console.log(`  ${f.padEnd(22)} ${cell(r)} ${cell(m)} ${cell(h)}`);
  }
}

console.log(`model ${MODEL} at ${URL_}, judged against a ${PRODUCTION_TIMEOUT_MS}ms production timeout`);
const tuned = await run(load("intent-eval.jsonl"), "tuned");
report("tuned set", tuned);
const holdout = await run(load("intent-eval-holdout.jsonl"), "held-out");
report("held-out set (totals only)", holdout);

const v = verdict({ tuned, holdout });
console.log(`\n${v.go ? "GO" : "NO GO"}`);
for (const r of v.reasons) console.log(`  ${r}`);
if (v.go) console.log("  Next: set LLM_WATCHER=ollama and read the watcher summary on real traffic before HYBRID_ROUTING.");
process.exitCode = v.go ? 0 : 1;
