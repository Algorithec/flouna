import { istWeekday } from "./istTime.js";
// The published policies, expressed as code.
//
// Every number in this file is a promise Algorithec makes in writing, in the
// policy set at `/legal`. They are gathered here, next to the clause each one
// comes from, for two reasons.
//
// The first is that a promise duplicated across handlers drifts. The refund
// window would end up as five minutes on the order screen and four on the
// server the first time somebody rounded it, and nobody would notice until a
// customer was told two different things by the same product.
//
// The second is that these are the lines an auditor reads. Written this way,
// "does the app do what the policy says" is answerable by reading one file and
// following its references, instead of by trusting a summary of the code.
//
// When a policy is amended, change it here and bump POLICY_VERSION. Deadlines
// already written onto a row are never recomputed from these constants, so an
// amendment cannot quietly move a commitment that was already made to someone.

/**
 * The version of the published policy set a user consents to.
 *
 * Stored on the account at sign-up. When this changes, existing users have
 * consented to an older text and must be asked again, which is what makes the
 * consent record evidence rather than decoration.
 */
export const POLICY_VERSION = "1.0";

/** When the current policy set took effect. Shown on every legal page. */
export const POLICY_EFFECTIVE = "28 May 2026";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Minimum age to hold an account. Terms 3.1, Privacy 8.1. */
export const MINIMUM_AGE_YEARS = 18;

/**
 * Free-cancellation window after payment. Refund policy 2.3.
 *
 * Inside it: cancel from the app, refund initiated immediately, in full, with
 * no questions asked. Outside it the seller's own policy governs and we can
 * only pass the request on.
 */
export const FREE_CANCEL_WINDOW_MS = 5 * MINUTE;

/** Refund policy 2.4, shown to the customer so the wait is never a surprise. */
export const REFUND_TIMELINE = {
  sellerApprovalHours: [24, 72] as const,
  byMethodDays: {
    upi: [1, 2] as const,
    card: [3, 5] as const,
    netbanking: [5, 7] as const,
    wallet: [1, 2] as const,
  },
  typicalBusinessDays: [5, 10] as const,
} as const;

/**
 * Support policy 3.2. First response and resolution targets per issue type.
 *
 * Deliberately in milliseconds rather than "2 hours" as text: these are used to
 * stamp a deadline on a ticket, and a number that has to be parsed before it
 * can be used is a number that will eventually be parsed wrongly.
 */
export type SlaTarget = { respondMs: number; resolveMs: number };

export const SUPPORT_SLA = {
  account: { respondMs: 2 * HOUR, resolveMs: 1 * DAY },
  payment: { respondMs: 2 * HOUR, resolveMs: 1 * DAY },
  order: { respondMs: 4 * HOUR, resolveMs: 1 * DAY },
  refund: { respondMs: 4 * HOUR, resolveMs: 5 * DAY },
  technical: { respondMs: 4 * HOUR, resolveMs: 1 * DAY },
  general: { respondMs: 24 * HOUR, resolveMs: 2 * DAY },
  // 3.2 lists no resolution target for feedback. It still gets a response
  // target, because "we will not reply" is not something the policy says.
  feedback: { respondMs: 48 * HOUR, resolveMs: 30 * DAY },
};

/**
 * Falls back to the slowest published tier, never to something faster.
 *
 * Returns a concrete target rather than a possibly-missing one: an unknown
 * category must still get a deadline, because the alternative is a ticket with
 * no promise attached that nobody is measured on.
 */
export function slaFor(category: string): SlaTarget {
  const row = (SUPPORT_SLA as Record<string, SlaTarget | undefined>)[category];
  return row ?? SUPPORT_SLA.general;
}

/** Grievance procedure. Support policy 3.7, privacy policy 10.3. */
export const GRIEVANCE_SLA = {
  assignMs: 48 * HOUR,
  contactMs: 5 * DAY,
  investigateMs: 30 * DAY,
  appealMs: 15 * DAY,
  /** Privacy grievances answer to 10.3, which is the stricter of the two. */
  privacyAcknowledgeMs: 30 * DAY,
  privacyResolveMs: 45 * DAY,
} as const;

/** Data-subject requests. Privacy policy 6.1, 6.2 and 6.4. */
export const PRIVACY_REQUEST_SLA = {
  exportMs: 30 * DAY,
  /** 6.2 allows 30 to 45 days. We publish the outer bound and aim inside it. */
  deletionMs: 45 * DAY,
  trainingOptOutMs: 30 * DAY,
  /**
   * How long a generated export stays downloadable.
   *
   * Not in the policy, which is exactly why it is short. An export is the most
   * sensitive single object we ever build about one person, and leaving it
   * addressable forever to satisfy a clause about producing it would trade a
   * disclosure duty for a disclosure risk.
   */
  exportDownloadableMs: 7 * DAY,
} as const;

/**
 * How long a deletion request can still be cancelled before it is carried out.
 *
 * Sits deliberately inside the 45 days the policy allows for processing, not
 * at it. Erasing exactly on the deadline leaves no room for a slow job or a
 * clock difference to turn a met promise into a broken one, and the gap costs
 * nothing: the account is already unusable to its owner during the wait.
 *
 * It is also the window in which somebody who was locked out, or who changed
 * their mind, can still come back. That is the whole reason erasure is
 * scheduled rather than immediate.
 */
export const DELETION_GRACE_MS = 30 * DAY;

/** Retention. Privacy policy 5.2. */
export const RETENTION = {
  accountAfterDeletionMs: 365 * DAY,
  /** Tax and regulatory. This is why erasure anonymises orders, not deletes. */
  transactionsMs: 7 * 365 * DAY,
  logsMs: 730 * DAY,
  marketingGraceMs: 90 * DAY,
} as const;

/** AI policy 2.5: an appeal is reviewed within five business days. */
export const AI_APPEAL_REVIEW_DAYS = 5;

/** Breach policy 3.3: 72 hours from becoming aware. */
export const BREACH_NOTIFY_MS = 72 * HOUR;

/**
 * Adds a number of business days, skipping Saturday and Sunday.
 *
 * The AI appeal deadline is the only commitment written in business days, and
 * treating those as calendar days would quietly make the promise stricter than
 * the published one, which is a promise we would then miss.
 *
 * Public holidays are not modelled. They vary by state in India, and guessing
 * would move the deadline in the customer's disfavour.
 */
export function addBusinessDays(from: Date, days: number): Date {
  // Stepped in plain milliseconds. setDate walks the HOST's calendar, which
  // moves by 23 or 25 hours across a daylight-saving boundary the customer
  // does not observe — and the weekday it is then compared against is India's,
  // so an hour of drift near midnight can misclassify a day and move the
  // published deadline by a whole one. India keeps no DST, so a fixed day is
  // correct here rather than a simplification.
  const DAY_MS = 24 * 60 * 60_000;
  let at = from.getTime();
  let left = days;
  while (left > 0) {
    at += DAY_MS;
    // Weekends are the rider's weekends, not the host's.
    const day = istWeekday(new Date(at));
    if (day !== 0 && day !== 6) left -= 1;
  }
  return new Date(at);
}

/**
 * Whether a date of birth clears the minimum age, as of `now`.
 *
 * Compares calendar dates rather than dividing by an average year length: a
 * year is not 365.25 days to a person born on 29 February, and someone turning
 * 18 today is 18 today.
 *
 * An unparseable date is not an adult. The caller decides whether that means
 * "reject" or "not provided", but it never means "let them through".
 */
export function meetsMinimumAge(dateOfBirth: string, now = new Date()): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateOfBirth.trim());
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dob = new Date(Date.UTC(y, mo - 1, d));
  // Rejects a date that rolled over, e.g. 2011-02-30 becoming 2 March.
  if (
    dob.getUTCFullYear() !== y ||
    dob.getUTCMonth() !== mo - 1 ||
    dob.getUTCDate() !== d
  ) {
    return false;
  }
  if (dob.getTime() > now.getTime()) return false;

  let age = now.getUTCFullYear() - y;
  const beforeBirthday =
    now.getUTCMonth() < mo - 1 ||
    (now.getUTCMonth() === mo - 1 && now.getUTCDate() < d);
  if (beforeBirthday) age -= 1;
  return age >= MINIMUM_AGE_YEARS;
}
