// Exports chat traffic as training data for our own intent model.
//
//   node scripts/export-training.mjs --since 2026-11-01 --until 2026-12-01 --out data/chat.jsonl
//
// One JSON line per customer message: the message and the reading the
// answering model made of it, in the same chat format as model/train_mlx.jsonl,
// plus which provider read it and how far down the chain. Customers who opted
// out of training are left out, contact details and identifying numbers are
// replaced, and no user, session or message id is written (see
// src/modules/chat/trainingExport.ts).
//
// Reads the database named by DATABASE_URL. Runs the compiled code, so build
// first: npm run build.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const arg = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);

const since = arg("--since");
const until = arg("--until");
const out = arg("--out");
const day = /^\d{4}-\d{2}-\d{2}$/;
if (!since || !until || !out || !day.test(since) || !day.test(until)) {
  console.error("usage: node scripts/export-training.mjs --since YYYY-MM-DD --until YYYY-MM-DD --out file.jsonl");
  process.exit(2);
}
if (!existsSync(resolve(HERE, "../dist/modules/chat/trainingExport.js"))) {
  console.error("No compiled export. Run `npm run build` first.");
  process.exit(2);
}

const { trainingExamples } = await import("../dist/modules/chat/trainingExport.js");
const { prisma } = await import("../dist/lib/prisma.js");
try {
  const examples = await trainingExamples({
    since: new Date(`${since}T00:00:00.000Z`),
    until: new Date(`${until}T00:00:00.000Z`),
  });
  mkdirSync(dirname(resolve(out)), { recursive: true });
  writeFileSync(out, examples.map((e) => JSON.stringify(e)).join("\n") + (examples.length ? "\n" : ""));
  const byProvider = new Map();
  for (const e of examples) byProvider.set(e.meta.provider, (byProvider.get(e.meta.provider) ?? 0) + 1);
  console.log(`wrote ${examples.length} examples to ${out}`);
  for (const [p, n] of byProvider) console.log(`  ${p ?? "unlabelled"}: ${n}`);
} finally {
  await prisma.$disconnect();
}
