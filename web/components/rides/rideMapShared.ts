// What the ride map draws, whichever engine draws it: the same elements on
// Google and on MapLibre, so the two can never disagree about what a rider sees.

/**
 * A named place, as a pill. Two identical pins tell a rider nothing about
 * which end is which; the name is what they check before they book.
 */
export function placeLabelElement(text: string, kind: "pickup" | "drop"): HTMLElement {
  const el = document.createElement("div");
  el.className =
    "flex items-center gap-1 rounded-full bg-white px-2 py-1 text-[10px] font-bold text-[#3d1c00] shadow-md whitespace-nowrap";
  if (kind === "drop") {
    const flag = document.createElement("span");
    flag.textContent = "🏁";
    flag.className = "text-[10px]";
    el.append(flag, document.createTextNode(text));
  } else {
    const dot = document.createElement("span");
    dot.className = "size-2 shrink-0 rounded-full";
    dot.style.background = "#1ca65c";
    el.append(dot, document.createTextNode(text));
  }
  return el;
}

/** A provider covering the route, as a pill placed along it. */
export function providerPillElement(name: string): HTMLElement {
  const el = document.createElement("div");
  const n = name.toLowerCase();
  let bg = "#3d1c00";
  let textCol = "white";
  if (n.includes("ola")) {
    bg = "#bada55";
    textCol = "black";
  } else if (n.includes("uber")) {
    bg = "black";
    textCol = "white";
  } else if (n.includes("rapido")) {
    bg = "#f6d000";
    textCol = "black";
  }
  el.className =
    "rounded-full px-2 py-0.5 text-[9px] font-bold uppercase tracking-wide shadow-md ring-2 ring-white/50";
  el.style.backgroundColor = bg;
  el.style.color = textCol;
  el.textContent = name;
  return el;
}

/** Up to three providers, spaced evenly along the route. */
export function providerPositions(
  providers: string[],
  routeGeometry: [number, number][] | null,
): { name: string; at: [number, number] }[] {
  if (providers.length === 0 || !routeGeometry || routeGeometry.length <= 3) return [];
  const seen = [...new Set(providers)].slice(0, 3);
  return seen.flatMap((name, i) => {
    const at = routeGeometry[Math.floor(((i + 1) / (seen.length + 1)) * (routeGeometry.length - 1))];
    return at ? [{ name, at }] : [];
  });
}

/**
 * A place name short enough to sit on a map. "Hitech city Madhapur road,
 * Kothaguda" is a useful line in a form field and a wall of text on a pin.
 */
export function shorten(name: string): string {
  const head = name.split(",")[0]!.trim();
  return head.length > 15 ? `${head.slice(0, 14)}…` : head;
}
