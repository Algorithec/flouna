// Translation checks, run as part of `npm run lint`.
//
// Two things fail it. A key present in English and missing from another
// language, which shows English in the middle of a Telugu screen. And visible
// English written straight into a screen that has been translated, which does
// the same thing more quietly: nobody notices until a customer who reads
// Kannada meets one English button.
//
// Only the screens listed below are held to the second rule. A screen joins
// the list once it is fully translated, so the list only grows.

const fs = require("fs");
const path = require("path");
const ts = require("typescript");

const ROOT = path.resolve(__dirname, "..");
const LANGS = ["en", "hi", "mr", "kn", "ta", "te"];

const TRANSLATED = [
  "app/(app)/profile/privacy/page.tsx",
  "app/(app)/profile/blocked/page.tsx",
  "app/(app)/profile/sessions/page.tsx",
  "app/(app)/profile/payment-methods/page.tsx",
  "app/(app)/profile/rewards/page.tsx",
  "app/(app)/profile/rewards/history/page.tsx",
  "app/(app)/profile/rewards/how-it-works/page.tsx",
  "app/(app)/profile/help/page.tsx",
  "app/(app)/profile/help/faqs/page.tsx",
  "app/(app)/profile/help/contact/page.tsx",
  "app/(app)/profile/help/chat/[id]/page.tsx",
  "app/(app)/profile/help/topics/[slug]/page.tsx",
  "components/security/AppLock.tsx",
  "components/chat/inline/InlinePayment.tsx",
  "components/chat/RecommendationCards.tsx",
  "components/chat/inline/InlineRideBooking.tsx",
  "components/rides/TripSummary.tsx",
  "components/chat/FoodHeroCard.tsx",
  "components/chat/WhyBest.tsx",
  "components/chat/DisagreeSheet.tsx",
  "components/chat/FlounaInsights.tsx",
  "components/chat/PlatformMark.tsx",
];

// Not prose: format examples a person copies the shape of, and identifiers.
const ALLOWED = new Set(["name@example.com", "name@bank", "NotAllowedError"]);

const problems = [];

// ---- every language has every key ----
const dict = fs.readFileSync(path.join(ROOT, "lib/i18n/dictionaries.ts"), "utf8").split("\r\n").join("\n");
const keysOf = (lang) => {
  const start = dict.indexOf(`\n  ${lang}: {\n`);
  const end = dict.indexOf("\n  },\n", start);
  if (start < 0 || end < 0) {
    problems.push(`dictionaries: no block for ${lang}`);
    return new Set();
  }
  return new Set([...dict.slice(start, end).matchAll(/^\s+"([^"]+)":/gm)].map((m) => m[1]));
};
const english = keysOf("en");
// A pattern that stops matching finds no keys, and then every language
// "agrees" with English. Refuse to pass on nothing.
if (english.size < 500) problems.push(`dictionaries: only ${english.size} English keys found; the check is not reading the file`);
for (const lang of LANGS.slice(1)) {
  const have = keysOf(lang);
  for (const k of english) if (!have.has(k)) problems.push(`dictionaries: ${lang} lacks "${k}"`);
  for (const k of have) if (!english.has(k)) problems.push(`dictionaries: ${lang} has "${k}", which English does not`);
}

// ---- no visible English in a translated screen ----
const ATTRS = new Set(["placeholder", "aria-label", "title", "alt", "label"]);
const SINKS = /^(toast|setError|setMessage|setNotice|alert)$/;
const looksLikeProse = (s) => (/[A-Za-z]{3,}/.test(s) && /\s/.test(s.trim())) || /^[A-Z][a-z]{2,}/.test(s);

function inVisibleSpot(node) {
  // A value compared against ("BEST PRICE" === badge) is data, not text.
  const parent = node.parent;
  if (
    ts.isBinaryExpression(parent) &&
    [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(parent.operatorToken.kind)
  ) {
    return false;
  }
  // Inside an attribute nobody reads (className, href, …) at any depth, such
  // as the branches of a className ternary.
  for (let p = node.parent; p; p = p.parent) {
    if (ts.isJsxAttribute(p)) {
      if (!ATTRS.has(p.name.getText())) return false;
      break;
    }
    if (ts.isFunctionLike(p) || ts.isSourceFile(p)) break;
  }
  for (let p = node.parent; p; p = p.parent) {
    if (ts.isJsxAttribute(p)) return ATTRS.has(p.name.getText());
    if (ts.isCallExpression(p)) {
      const callee = p.expression.getText().split(".").pop();
      if (callee === "t" || callee === "replace" || callee === "cn") return false;
      if (SINKS.test(callee)) return true;
    }
    if (ts.isJsxExpression(p)) return true;
    if (ts.isFunctionLike(p) || ts.isSourceFile(p)) return false;
  }
  return false;
}

for (const rel of TRANSLATED) {
  const file = path.join(ROOT, rel);
  const sf = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const report = (node, text) => {
    if (ALLOWED.has(text)) return;
    const line = sf.getLineAndCharacterOfPosition(node.getStart()).line + 1;
    problems.push(`${rel}:${line} shows untranslated "${text.slice(0, 80)}"`);
  };
  const visit = (n) => {
    if (ts.isImportDeclaration(n)) return;
    if (ts.isJsxText(n)) {
      const text = n.text.replace(/\s+/g, " ").trim();
      // Entities such as &ldquo; and &middot; are punctuation, not words.
      if (/[A-Za-z]{2,}/.test(text.replace(/&[a-z]+;/gi, ""))) report(n, text);
    } else if (ts.isJsxAttribute(n) && ATTRS.has(n.name.getText()) && n.initializer && ts.isStringLiteral(n.initializer)) {
      if (/[A-Za-z]{3,}/.test(n.initializer.text)) report(n, n.initializer.text);
      return;
    } else if (
      (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) &&
      !ts.isJsxAttribute(n.parent) &&
      looksLikeProse(n.text) &&
      inVisibleSpot(n)
    ) {
      // Gradients and other CSS values passed through style props.
      if (!/^(linear|radial)-gradient\(|^#[0-9a-f]{3,8}$/i.test(n.text)) report(n, n.text);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
}

if (problems.length) {
  console.error(problems.join("\n"));
  console.error(`\n${problems.length} translation problem(s)`);
  process.exit(1);
}
console.log(`translations: ${english.size} keys in ${LANGS.length} languages, ${TRANSLATED.length} screens clean`);
