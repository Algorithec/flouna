// Layer 3 of the LLM firewall: cheap input checks that run BEFORE any
// model call — obvious junk never costs an API request.

import { FIXED_REPLIES } from "./replies.js";

const MAX_MESSAGE_LENGTH = 500;

// Cheap heuristic pre-filter, NOT a security boundary. These patterns catch a
// few obvious injection phrasings to save an API call by routing them straight
// to out_of_scope. They are trivially bypassed (rephrasing, unicode, spacing)
// and may false-positive on legitimate input, so the real protection is the
// constrained JSON intent schema the model must return — never this list.
const INJECTION_PATTERNS = [
  /ignore (all |your |previous |prior )*(instructions|rules|prompt)/i,
  /you are now\b/i,
  /act as\b/i,
  /pretend (to be|you are)/i,
  /system prompt/i,
  /jailbreak/i,
  /developer mode/i,
  /\bDAN\b/,
];

export type FirewallVerdict =
  | { ok: true }
  | { ok: false; reason: "too_long" | "empty" | "injection" };

export function checkMessage(raw: string): FirewallVerdict {
  const message = raw.trim();
  if (!message) return { ok: false, reason: "empty" };
  if (message.length > MAX_MESSAGE_LENGTH) return { ok: false, reason: "too_long" };
  if (INJECTION_PATTERNS.some((p) => p.test(message))) {
    return { ok: false, reason: "injection" };
  }
  return { ok: true };
}

export const FIREWALL_REPLIES: Record<
  Exclude<FirewallVerdict, { ok: true }>["reason"],
  string
> = {
  empty: FIXED_REPLIES.empty,
  too_long: FIXED_REPLIES.tooLong,
  injection: FIXED_REPLIES.outOfScope,
};
