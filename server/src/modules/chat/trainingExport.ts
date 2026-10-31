import { prisma } from "../../lib/prisma.js";

// Real chat traffic as training data for our own intent model.
//
// Each customer message is paired with the reading the answering model made of
// it, which chat stores beside the reply (the `reading` key of the assistant
// message's intent JSON, from the first message onward). Privacy policy 6.4
// lets anonymised data train models unless the customer opted out, so:
//
//   - customers who opted out are left out entirely, from the moment they opt
//     out, not after the 30 days the policy allows;
//   - no user, session or message id leaves here, only the date;
//   - contact details and identifying numbers are replaced in the message and
//     in every string of the reading before anything is returned.
//
// Prices and quantities stay: "biryani under 300" is exactly what the model has
// to learn to read, and a budget does not identify anyone.

export type TrainingExample = {
  messages: [{ role: "user"; content: string }, { role: "assistant"; content: string }];
  meta: { provider: string | null; depth: number | null; date: string };
};

const SCRUBS: [RegExp, string][] = [
  // Order matters: an email contains an @, and so does a UPI id.
  [/[\w.+-]+@[\w-]+\.[\w.-]+/g, "<email>"],
  [/\b[\w.-]{2,}@[a-z]{2,}\b/gi, "<upi>"],
  // Indian mobiles, with or without +91 and a space in the middle.
  [/(?<!\d)(?:\+?91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}(?!\d)/g, "<phone>"],
  // Aadhaar and card numbers written in groups of four, and any unbroken run
  // of nine or more digits (account numbers). Separate prices such as
  // "300 400 500" are left alone.
  [/(?<!\d)(?:\d{4}[\s-]){2,3}\d{4}(?!\d)/g, "<number>"],
  [/(?<!\d)\d{9,}(?!\d)/g, "<number>"],
  // A PIN code places a home within a few streets.
  [/(?<!\d)[1-9]\d{5}(?!\d)/g, "<pincode>"],
];

/** The text with contact details and identifying numbers replaced. */
export function scrub(text: string): string {
  return SCRUBS.reduce((t, [re, to]) => t.replace(re, to), text);
}

/** Every string inside a reading scrubbed; structure and numbers untouched. */
function scrubDeep(value: unknown): unknown {
  if (typeof value === "string") return scrub(value);
  if (Array.isArray(value)) return value.map(scrubDeep);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrubDeep(v)]));
  }
  return value;
}

export async function trainingExamples(opts: { since: Date; until: Date }): Promise<TrainingExample[]> {
  const rows = await prisma.chatMessage.findMany({
    where: {
      createdAt: { gte: opts.since, lt: opts.until },
      session: { user: { aiTrainingOptOut: false } },
    },
    select: { sessionId: true, role: true, content: true, intent: true, provider: true, providerDepth: true, createdAt: true },
    orderBy: [{ sessionId: "asc" }, { createdAt: "asc" }],
  });

  const out: TrainingExample[] = [];
  let lastUser: { sessionId: string; content: string } | null = null;
  for (const row of rows) {
    if (row.role === "user") {
      lastUser = { sessionId: row.sessionId, content: row.content };
      continue;
    }
    // An assistant message: pair it with the customer message just before it.
    const asked = lastUser && lastUser.sessionId === row.sessionId ? lastUser.content : null;
    lastUser = null;
    if (!asked || !row.intent) continue;
    let reading: unknown;
    try {
      reading = (JSON.parse(row.intent) as { reading?: unknown }).reading;
    } catch {
      continue;
    }
    if (!reading) continue;
    out.push({
      messages: [
        { role: "user", content: scrub(asked) },
        { role: "assistant", content: JSON.stringify(scrubDeep(reading)) },
      ],
      meta: { provider: row.provider, depth: row.providerDepth, date: row.createdAt.toISOString().slice(0, 10) },
    });
  }
  return out;
}
