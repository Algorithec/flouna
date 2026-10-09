"use client";

import { useI18n } from "@/components/i18n/I18nContext";
// Marks for the platforms the engine searched.
//
// Drawn as inline SVG stand-ins rather than shipped as real logo files, for the
// same reason the payment marks are: the trademarks are not ours to bundle,
// and a vector keeps its edge at any size and in either theme. Each keeps its
// brand's own colour, because being recognisable at a glance is the entire job
// here.
//
// The point of showing them is evidence. "We compared these" is a claim, and a
// row of the actual places we looked is the proof of it. That is worth more to
// a person deciding whether to trust the answer than another sentence saying
// the same thing.

const BRANDS: Record<
  string,
  { label: string; bg: string; fg: string; short: string }
> = {
  swiggy: { label: "Swiggy", bg: "#fc8019", fg: "#ffffff", short: "S" },
  zomato: { label: "Zomato", bg: "#e23744", fg: "#ffffff", short: "Z" },
  uber: { label: "Uber", bg: "#000000", fg: "#ffffff", short: "U" },
  ola: { label: "Ola", bg: "#1c1c1c", fg: "#c9f31d", short: "O" },
  rapido: { label: "Rapido", bg: "#f8d000", fg: "#1c1c1c", short: "R" },
  ondc: { label: "ONDC", bg: "#1a73a7", fg: "#ffffff", short: "O" },
  amazon: { label: "Amazon", bg: "#232f3e", fg: "#ffffff", short: "A" },
  flipkart: { label: "Flipkart", bg: "#2874f0", fg: "#ffffff", short: "F" },
  myntra: { label: "Myntra", bg: "#ff3f6c", fg: "#ffffff", short: "M" },
  croma: { label: "Croma", bg: "#1d1d1b", fg: "#f5c518", short: "C" },
};

export function platformLabel(id: string): string {
  return BRANDS[id.toLowerCase()]?.label ?? id;
}

/** Compact named pill used on alternative rows — brand colour, not a huge logo. */
export function PlatformChip({
  id,
  variant = "solid",
}: {
  id: string;
  variant?: "solid" | "outline";
}) {
  const key = id.toLowerCase();
  const b = BRANDS[key] ?? {
    label: id,
    bg: "#8b5e3c",
    fg: "#ffffff",
    short: id.slice(0, 1).toUpperCase(),
  };
  if (variant === "outline") {
    return (
      <span className="inline-flex items-center rounded-full border border-ink/20 bg-card px-2 py-[2px] text-[10px] font-semibold text-ink">
        {b.label}
      </span>
    );
  }
  if (key === "zomato") {
    return (
      <span className="inline-flex items-center text-[12px] font-extrabold tracking-tight text-[#e23744]">
        {b.label}
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-0.5 rounded-full px-2 py-[2px] text-[10px] font-bold tracking-wide"
      style={{ background: b.bg, color: b.fg }}
    >
      {(key === "swiggy" || key === "ondc") && (
        <svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor" aria-hidden>
          <path d="M4 0a3 3 0 0 1 3 3c0 2.2-3 5-3 5S1 5.2 1 3a3 3 0 0 1 3-3Zm0 4.1A1.1 1.1 0 1 0 4 1.9a1.1 1.1 0 0 0 0 2.2Z" />
        </svg>
      )}
      {b.label}
    </span>
  );
}

/** A single round mark. Falls back to the first letter of anything unknown. */
export function PlatformMark({
  id,
  size = 20,
}: {
  id: string;
  size?: number;
}) {
  const key = id.toLowerCase();
  const b = BRANDS[key] ?? {
    label: id,
    bg: "#8b5e3c",
    fg: "#ffffff",
    short: id.slice(0, 1).toUpperCase(),
  };
  return (
    <span
      // Titled rather than labelled: these sit inside a row that already
      // names them for a screen reader, so repeating each one would read the
      // list twice.
      title={b.label}
      aria-hidden
      className="inline-flex shrink-0 items-center justify-center rounded-full ring-2 ring-card"
      style={{
        width: size,
        height: size,
        background: b.bg,
        color: b.fg,
        fontSize: Math.round(size * 0.5),
        fontWeight: 700,
        lineHeight: 1,
      }}
    >
      {b.short}
    </span>
  );
}

/**
 * The row of places we looked, shown under the reasoning as evidence for it.
 *
 * Overlapped slightly so a long list stays compact on a phone, and capped so
 * it can never push the answer off the screen: past the cap it counts the rest
 * rather than wrapping to a second line.
 *
 * copy="compared" (default): "Compared across Swiggy, Zomato and 1 more"
 * copy="checked-count": "Checked 5 providers for you"
 *   The count is the number checked, exactly, with no "+": the cap is about
 *   how many marks fit on a phone and says nothing about how many were
 *   compared. The named variant lists only the ones actually shown, so the
 *   names and the marks always agree, with the remainder counted after them.
 */
export function SearchedPlatforms({
  platforms,
  max = 6,
  copy = "compared",
}: {
  platforms: string[];
  max?: number;
  copy?: "compared" | "checked-count";
}) {
  const { t } = useI18n();
  // Deduplicated in place so the order follows the ranking rather than an
  // alphabet: the first mark is the platform that won.
  const seen: string[] = [];
  for (const p of platforms) {
    const k = p?.toLowerCase();
    if (k && !seen.includes(k)) seen.push(k);
  }
  if (seen.length === 0) return null;

  const shown = seen.slice(0, max);
  const rest = seen.length - shown.length;

  return (
    <div className="flex items-center gap-2">
      <span className="flex items-center -space-x-1.5">
        {shown.map((p) => (
          <PlatformMark key={p} id={p} />
        ))}
      </span>
      <span className="text-[11px] text-cocoa">
        {copy === "checked-count" ? (
          // Says how many we compared, not which ones — the marks themselves
          // show which. Exactly how many, with no "+": the cap is about how
          // many marks fit on a phone, so "8+" for eight claimed more than
          // had been looked at.
          <>{t("pm.comparedN").replace("{n}", String(seen.length))}</>
        ) : (
          // Default: names every platform as evidence for the claim above.
          // Screen readers get the names here since the marks are aria-hidden.
          <>
            {t("pm.comparedAcross").replace("{names}", shown.map(platformLabel).join(", "))}
            {rest > 0 ? t("pm.andMore").replace("{n}", String(rest)) : ""}
          </>
        )}
      </span>
    </div>
  );
}
