// Facts about the policy set that the pages around it need.
//
// POLICY_VERSION is duplicated from the server's policy.ts on purpose. The
// server owns it, because the server is what refuses a sign-up that has not
// accepted the current text; this copy only labels a page. A test asserts the
// two agree, so the duplication cannot drift silently.

export const POLICY_VERSION = "1.0";
export const POLICY_EFFECTIVE = "28 May 2026";

/** The published set, in the order the index lists them. */
export const POLICY_INDEX = [
  {
    slug: "privacy",
    title: "Privacy Policy",
    blurb: "What we collect, why, who sees it, and the rights you have over it.",
  },
  {
    slug: "terms",
    title: "Terms of Service",
    blurb: "The agreement between you and Algorithec when you use Flouna.",
  },
  {
    slug: "acceptable-use",
    title: "Acceptable Use and AI Policy",
    blurb: "What is allowed on Flouna, and how the decision engine reaches its answers.",
  },
  {
    slug: "cookies",
    title: "Cookie, Refund and Support Policy",
    blurb: "Cookies, cancellations and refunds, and how to reach a person.",
  },
  {
    slug: "security",
    title: "Security, Accessibility and Breach Policy",
    blurb: "How your data is protected, and what happens if that ever fails.",
  },
  {
    slug: "accessibility",
    title: "Accessibility Statement",
    blurb: "Where Flouna meets the standard today, and where it does not yet.",
  },
] as const;

/**
 * Published contact points.
 *
 * These come from the policy documents. A published address that bounces is
 * worse than no address, because someone exercising a legal right has been
 * told to write somewhere nobody reads. Each one is an alias of
 * info@algorithec.com; the policies named algorithec.ai, which has no mail
 * (see PUBLISHED_MAILBOXES in corrections.ts).
 */
export const CONTACTS = {
  support: "support@algorithec.com",
  grievance: "grievance@algorithec.com",
  privacy: "privacy@algorithec.com",
  security: "security@algorithec.com",
  accessibility: "accessibility@algorithec.com",
  legal: "legal@algorithec.com",
  escalation: "escalation@algorithec.com",
  phone: "+91 7396144250",
} as const;

export const REGISTERED_ADDRESS = [
  "Algorithec Private Limited",
  "Unit 101, Oxford Towers, 139/88",
  "HAL Old Airport Road, HAL 2nd Stage",
  "Bangalore North, Bangalore 560008",
  "Karnataka, India",
];
