import type { Metadata } from "next";
import { Playfair_Display, Inter, IBM_Plex_Mono } from "next/font/google";

// Standalone brand-board preview for the founder. Self-contained: its own fonts
// and inline styles, no shared Radiues tokens — the existing app theme is
// untouched. Screenshot-friendly single page. Not indexed.
export const metadata: Metadata = {
  title: "Brand Theme Preview",
  robots: { index: false, follow: false },
};

const serif = Playfair_Display({ subsets: ["latin"], weight: ["700", "900"], style: ["normal", "italic"] });
const sans = Inter({ subsets: ["latin"], weight: ["400", "500", "600"] });
const mono = IBM_Plex_Mono({ subsets: ["latin"], weight: ["500", "600"] });

// The palette from the brief.
const COLORS = [
  { name: "Deep Maroon", hex: "#7B0C1B", usage: "Primary background, headings", dark: true },
  { name: "Dark Crimson", hex: "#5C0710", usage: "Header bar, darker sections", dark: true },
  { name: "Bright Red", hex: "#C0392B", usage: "Accent, stipend amount highlight", dark: true },
  { name: "Amber / Gold", hex: "#E8A020", usage: "Subtitle tagline text", dark: false },
  { name: "Warm Ivory", hex: "#F5F0E8", usage: "Selection task box bg", dark: false },
  { name: "White", hex: "#FFFFFF", usage: "Body background, text on dark", dark: false },
  { name: "Near Black", hex: "#2C2C2C", usage: "Body text, paragraph copy", dark: true },
  { name: "Dark Gold", hex: "#B8860B", usage: "Task box dashed border", dark: true },
];

const C = {
  maroon: "#7B0C1B",
  crimson: "#5C0710",
  red: "#C0392B",
  amber: "#E8A020",
  ivory: "#F5F0E8",
  ink: "#2C2C2C",
  gold: "#B8860B",
};

export default function ThemePreviewPage() {
  return (
    <main className={sans.className} style={{ background: "#FFFFFF", color: C.ink, minHeight: "100vh" }}>
      {/* ── Hero on maroon ── */}
      <header style={{ background: C.maroon, padding: "56px 32px 48px" }}>
        <div style={{ maxWidth: 980, margin: "0 auto" }}>
          <p className={mono.className} style={{ color: C.amber, letterSpacing: "0.22em", fontSize: 12, textTransform: "uppercase" }}>
            Algorithec · Brand System
          </p>
          <h1 className={serif.className} style={{ color: "#fff", fontSize: 56, lineHeight: 1.05, fontWeight: 900, margin: "14px 0 10px" }}>
            Display Heading
          </h1>
          <p className={serif.className} style={{ color: C.amber, fontStyle: "italic", fontWeight: 700, fontSize: 22 }}>
            A tagline in amber gold, serif bold italic.
          </p>
        </div>
      </header>

      <div style={{ maxWidth: 980, margin: "0 auto", padding: "44px 32px 72px" }}>
        {/* ── Colours ── */}
        <SectionLabel>Colours</SectionLabel>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 16, marginTop: 18 }}>
          {COLORS.map((c) => (
            <div key={c.name} style={{ border: "1px solid #E6E0D8", borderRadius: 12, overflow: "hidden", background: "#fff" }}>
              <div style={{ height: 92, background: c.hex, borderBottom: c.hex === "#FFFFFF" ? "1px solid #E6E0D8" : "none" }} />
              <div style={{ padding: "12px 14px" }}>
                <div style={{ fontWeight: 600, fontSize: 14 }}>{c.name}</div>
                <div className={mono.className} style={{ color: C.red, fontSize: 12, margin: "3px 0" }}>{c.hex}</div>
                <div style={{ color: "#8A8178", fontSize: 12, lineHeight: 1.4 }}>{c.usage}</div>
              </div>
            </div>
          ))}
        </div>

        {/* ── Typography ── */}
        <SectionLabel style={{ marginTop: 48 }}>Typography</SectionLabel>
        <div style={{ marginTop: 18, display: "flex", flexDirection: "column", gap: 22 }}>
          <TypeRow n="1" label="Display Heading — Serif Bold">
            <span className={serif.className} style={{ fontWeight: 900, fontSize: 40, color: C.maroon }}>
              Stop Searching, Start Deciding
            </span>
          </TypeRow>
          <TypeRow n="2" label="Tagline — Serif Bold Italic, amber">
            <span className={serif.className} style={{ fontStyle: "italic", fontWeight: 700, fontSize: 24, color: C.amber }}>
              The smartest choice, every time.
            </span>
          </TypeRow>
          <TypeRow n="3" label="Section Labels — Mono All-Caps, wide tracking">
            <span className={mono.className} style={{ letterSpacing: "0.2em", fontSize: 14, color: C.ink, textTransform: "uppercase" }}>
              Stipend · Duration · Eligibility
            </span>
          </TypeRow>
          <TypeRow n="4" label="Body Text — Clean Sans-Serif">
            <span style={{ fontSize: 15, lineHeight: 1.6, color: C.ink }}>
              Body copy uses a clean sans-serif for readability across long paragraphs and UI labels, balanced against the serif headings.
            </span>
          </TypeRow>
          <TypeRow n="5" label="Technical / Code — Monospace">
            <span className={mono.className} style={{ fontSize: 14, color: "#555" }}>
              GET /api/decisions · INV-202606-A1B2C3
            </span>
          </TypeRow>
          <TypeRow n="6" label="Large Numerals — Heavy serif, large">
            <span className={serif.className} style={{ fontWeight: 900, fontSize: 64, color: C.red, lineHeight: 1 }}>
              ₹25,000
            </span>
          </TypeRow>
        </div>

        {/* ── Sample components ── */}
        <SectionLabel style={{ marginTop: 48 }}>Components</SectionLabel>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18, marginTop: 18 }}>
          {/* Stipend / highlight card */}
          <div style={{ background: C.crimson, borderRadius: 16, padding: "26px 24px", color: "#fff" }}>
            <p className={mono.className} style={{ color: C.amber, letterSpacing: "0.18em", fontSize: 11, textTransform: "uppercase" }}>
              Stipend
            </p>
            <p className={serif.className} style={{ fontWeight: 900, fontSize: 44, margin: "8px 0 4px" }}>
              ₹25,000<span style={{ fontSize: 18, color: C.amber }}>/mo</span>
            </p>
            <p style={{ color: "#E9D9D9", fontSize: 13 }}>Paid monthly · 6-month duration</p>
            <button style={{ marginTop: 18, background: C.amber, color: C.crimson, border: "none", borderRadius: 999, padding: "10px 20px", fontWeight: 600, fontSize: 14, cursor: "pointer" }}>
              Apply now
            </button>
          </div>

          {/* Task box — ivory bg, dashed gold border */}
          <div style={{ background: C.ivory, border: `2px dashed ${C.gold}`, borderRadius: 16, padding: "24px" }}>
            <p className={mono.className} style={{ color: C.gold, letterSpacing: "0.18em", fontSize: 11, textTransform: "uppercase" }}>
              Task
            </p>
            <p className={serif.className} style={{ color: C.maroon, fontWeight: 700, fontSize: 22, margin: "8px 0 6px" }}>
              Build the decision engine demo
            </p>
            <p style={{ color: C.ink, fontSize: 14, lineHeight: 1.55 }}>
              Selection task box on warm ivory with the dark-gold dashed border, maroon heading, and near-black body copy.
            </p>
            <div style={{ marginTop: 16, display: "flex", gap: 10 }}>
              <Pill bg={C.red}>Accent</Pill>
              <Pill bg={C.maroon}>Primary</Pill>
              <Pill bg={C.gold}>Gold</Pill>
            </div>
          </div>
        </div>

        <p className={mono.className} style={{ marginTop: 40, color: "#B0A99F", fontSize: 11, textAlign: "center", letterSpacing: "0.1em" }}>
          ALGORITHEC — THEME PREVIEW
        </p>
      </div>
    </main>
  );
}

function SectionLabel({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <p className={mono.className} style={{ letterSpacing: "0.2em", fontSize: 12, color: "#9A9189", textTransform: "uppercase", ...style }}>
      {children}
    </p>
  );
}

function TypeRow({ n, label, children }: { n: string; label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", gap: 18, alignItems: "baseline" }}>
      <span className={mono.className} style={{ color: "#C0392B", fontSize: 13, width: 18, flexShrink: 0 }}>{n}</span>
      <div>
        <div style={{ color: "#8A8178", fontSize: 12, marginBottom: 6 }}>{label}</div>
        {children}
      </div>
    </div>
  );
}

function Pill({ bg, children }: { bg: string; children: React.ReactNode }) {
  return (
    <span style={{ background: bg, color: "#fff", borderRadius: 999, padding: "5px 14px", fontSize: 12, fontWeight: 600 }}>
      {children}
    </span>
  );
}
