// Claims corrected before publication.
//
// The source policy documents describe a company with audited certifications,
// a standing bug bounty and a quarterly penetration-testing programme. Those
// are not aspirations a policy is free to state, they are factual claims about
// things that either happened or did not, and each one is verifiable by asking
// for a certificate or a report.
//
// Publishing a claim of ISO 27001 or SOC 2 Type II without the audit is a
// misrepresentation, and it is a bad one to make in a document whose whole job
// is to be trusted. It is also the first thing a reviewer can check. So the
// claims are rewritten here to say what is actually true, which in most cases
// is still a decent answer: we have no SOC 2 report, but we also never touch a
// card number, and that is the substance a reader wants.
//
// Every entry below is a change from what the founder wrote. None of them are
// silent: they are listed in the handover notes so the wording can be put back
// the day the certificate exists, or amended if any of this is wrong.
//
// Applied at render time rather than baked into documents.ts so that
// re-running the converter cannot quietly drop a correction.

import { POLICY_DOCUMENTS, type Block, type PolicyDocument } from "./documents";

type Correction = {
  /** Why the original could not be published as written. */
  reason: string;
  /** Matches the list item or paragraph to replace. */
  match: string;
  /** Replacement text, or null to remove the line entirely. */
  replace: string | null;
};

const CORRECTIONS: Correction[] = [
  // --- Certifications we do not hold ---
  {
    reason: "No ISO 27001 audit has been carried out. Claiming the certification is a misrepresentation.",
    match: "ISO 27001 (or equivalent)",
    replace: "Built with reference to ISO 27001 practice. We are not certified.",
  },
  {
    reason: "No SOC 2 audit has been carried out, and SOC 2 Type II specifically requires an observation window.",
    match: "SOC 2 Type II",
    replace: null,
  },
  {
    reason:
      "PCI DSS applies to whoever handles card data. We never see a card number: payments go to Cashfree, who are certified. Saying so is both true and more reassuring than the original.",
    match: "PCI DSS (for payment data)",
    replace:
      "Card and UPI details are handled entirely by our PCI DSS certified payment partner. Flouna never receives or stores them.",
  },
  {
    reason: "IS 15408 is a product-evaluation standard requiring formal certification we have not sought.",
    match: "Indian Standards (IS 15408)",
    replace: null,
  },
  {
    reason:
      "The NIST framework is guidance rather than something you are certified against, so 'compliant with' overstates it.",
    match: "NIST Cybersecurity Framework",
    replace: "NIST Cybersecurity Framework, used as guidance",
  },

  // --- Activities that are not happening yet ---
  {
    reason: "No external penetration test has been commissioned.",
    match: "Regular penetration testing (quarterly)",
    replace: "Automated dependency and vulnerability scanning on every build",
  },
  {
    reason: "There is no bug bounty programme. The reporting address, however, is real.",
    match: "Bug bounty program active",
    replace: null,
  },
  {
    reason: "Follows from there being no bounty programme.",
    match: "Bug bounty findings",
    replace: null,
  },
  {
    reason: "No annual audit has taken place: the company has not completed a year of operation.",
    match: "Annual security audit",
    replace: "Internal security review before each major release",
  },
  {
    reason: "No external penetration test has been commissioned.",
    match: "Quarterly penetration tests",
    replace: null,
  },
  {
    reason: "No third-party review has been commissioned.",
    match: "Third-party security review",
    replace: null,
  },
  {
    reason: "No external compliance audit has taken place.",
    match: "Annual compliance audit",
    replace: null,
  },
  {
    reason:
      "This describes what we require of vendors. We do use vendors who hold these certifications, so the requirement stands, but softened from 'required' to what we actually check.",
    match: "SOC 2 or ISO 27001 certification required",
    replace: "Certification such as SOC 2 or ISO 27001 preferred when available",
  },

  // --- Accessibility, where the claim outruns the product ---
  {
    reason:
      "WCAG 2.1 AA is a measurable bar and we do not currently clear it: several colour pairings built on the brand accent fall below the contrast minimum. 'We aim to meet' is honest and still commits us. The accessibility statement lists the known gaps.",
    match:
      "Algorithec is committed to making our Platform accessible to people with disabilities. We strive to meet WCAG 2.1 Level AA accessibility standards and continuously improve accessibility.",
    replace:
      "Algorithec is committed to making Flouna accessible to people with disabilities. We build to WCAG 2.1 Level AA as our target standard and are not yet fully conformant. Our accessibility statement lists the gaps we know about and what we are doing about each one, and we would rather publish that than a claim we cannot support.",
  },
  {
    reason: "Same reason: stated as achieved rather than as the target.",
    match: "WCAG 2.1 Level AA compliance",
    replace: "WCAG 2.1 Level AA as the target standard, with known gaps published",
  },
  {
    reason: "No third-party accessibility audit has been commissioned.",
    match: "Third-party accessibility audit",
    replace: null,
  },
  {
    reason: "Overstates the testing that has actually been done.",
    match: "Extensive accessibility testing",
    replace: "Accessibility testing on every release, at three screen widths and both themes",
  },
];

const BY_MATCH = new Map(CORRECTIONS.map((c) => [c.match, c]));

// --- Contact addresses ---
//
// The source documents give every contact address, and the website, on
// algorithec.ai. The company does not hold that domain: it has no DNS at all,
// so every mail sent to a published address bounced, including the grievance
// and privacy contacts the law requires us to publish. The same mailboxes were
// set up on algorithec.com (aliases of info@algorithec.com, 30 Oct 2026), and
// www.algorithec.com is the company's site, so the domain is rewritten
// wherever it appears. Unlike the corrections above this changes part of a
// line, so it runs after them and on every kind of block.
const DEAD_DOMAIN = "algorithec.ai";
const LIVE_DOMAIN = "algorithec.com";

/**
 * Every address on algorithec.com that exists as a mailbox or alias. A policy
 * that publishes any other address on the domain fails the build below, since
 * the mail would be lost as surely as it was on algorithec.ai.
 */
export const PUBLISHED_MAILBOXES = new Set([
  "info",
  "official",
  "support",
  "grievance",
  "privacy",
  "security",
  "accessibility",
  "legal",
  "escalation",
  "ai-fairness",
  "appeals",
  "feedback",
  "dpo",
  "ceo",
]);

function liveDomain(text: string): string {
  return text.split(DEAD_DOMAIN).join(LIVE_DOMAIN);
}

function fixItems(items: string[]): string[] {
  const out: string[] = [];
  for (const item of items) {
    const c = BY_MATCH.get(item);
    if (!c) {
      out.push(item);
      continue;
    }
    if (c.replace !== null) out.push(c.replace);
  }
  return out;
}

function fixBlock(b: Block): Block | null {
  if (b.t === "ul") {
    const items = fixItems(b.items);
    // A list emptied by corrections would leave its heading introducing
    // nothing, so the block is dropped rather than rendered blank.
    return items.length ? { ...b, items } : null;
  }
  if (b.t === "p") {
    const c = BY_MATCH.get(b.text);
    if (!c) return b;
    return c.replace === null ? null : { ...b, text: c.replace };
  }
  return b;
}

function liveDomainBlock(b: Block): Block {
  switch (b.t) {
    case "h":
    case "p":
      return { ...b, text: liveDomain(b.text) };
    case "ul":
      return { ...b, items: b.items.map(liveDomain) };
    case "table":
      return { ...b, head: b.head.map(liveDomain), rows: b.rows.map((r) => r.map(liveDomain)) };
  }
}

/** Applies the corrections to one document. */
export function correct(doc: PolicyDocument): PolicyDocument {
  const blocks = doc.blocks
    .map(fixBlock)
    .filter((b): b is Block => b !== null)
    .map(liveDomainBlock);
  return { ...doc, blocks };
}

export const ALL_CORRECTIONS = CORRECTIONS;

/**
 * Fails the build if a correction no longer matches anything.
 *
 * The documents are regenerated from the source files by a converter. If
 * somebody reruns it after the founder rewords a line, a correction can stop
 * matching, and the uncorrected claim goes back on the site silently. That is
 * the one failure mode of this design worth engineering against, because the
 * result is publishing a false certification claim and nobody noticing.
 *
 * Running at module scope means it happens during prerender, so the build
 * breaks rather than the page. The data is checked into the repo, so a build
 * that passes this can never fail it later at runtime.
 */
function verifyCorrectionsStillApply(): void {
  const seen = new Set<string>();
  for (const doc of POLICY_DOCUMENTS) {
    for (const b of doc.blocks) {
      if (b.t === "ul") for (const item of b.items) seen.add(item);
      else if (b.t === "p") seen.add(b.text);
    }
  }
  const stale = CORRECTIONS.filter((c) => !seen.has(c.match));
  if (stale.length) {
    throw new Error(
      "Policy corrections no longer match the source documents, so the " +
        "original claims would be published uncorrected. Re-check these " +
        "against the current text:\n" +
        stale.map((c) => `  - ${JSON.stringify(c.match)}`).join("\n"),
    );
  }
}

verifyCorrectionsStillApply();

/**
 * Fails the build if a published policy names an address on the company's
 * domain that is not a real mailbox, or still names the dead domain.
 */
function verifyPublishedAddresses(): void {
  const problems = new Set<string>();
  for (const doc of POLICY_DOCUMENTS) {
    const text = JSON.stringify(correct(doc).blocks);
    if (text.includes(DEAD_DOMAIN)) problems.add(`${doc.slug} still names ${DEAD_DOMAIN}`);
    for (const m of text.matchAll(/([a-z0-9._-]+)@algorithec\.com/gi)) {
      if (!PUBLISHED_MAILBOXES.has(m[1]!.toLowerCase())) problems.add(`${doc.slug} names ${m[0]}, which is not a mailbox`);
    }
  }
  if (problems.size) {
    throw new Error(
      "Policy contact addresses would not receive mail:\n" + [...problems].map((p) => `  - ${p}`).join("\n"),
    );
  }
}

verifyPublishedAddresses();
