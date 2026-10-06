"use client";

import { useState } from "react";
import Image from "next/image";

// Dish artwork.
//
// A real photograph when the catalogue has one, and a drawn stand-in when it
// does not: a deterministic two-tone gradient with a glyph picked from the
// dish name, so the same dish always renders the same tile and the palette
// stays inside the brand's warm range.
//
// The fallback is not a placeholder to be removed later, it is the permanent
// answer for a dish whose photo is missing, slow, or 404s. An ONDC catalogue
// will not have a picture of everything, and a broken image icon in a list of
// food is worse than a tile that was designed.
//
// To add real photography: drop the file in `public/dishes/` and set `image`
// on the dish in the catalogue, e.g. "/dishes/dum-biryani.jpg". Nothing else
// needs changing; every surface passes the image through to here.

const VISUALS: { match: RegExp; emoji: string; from: string; to: string }[] = [
  { match: /biryani|pulao|rice/i, emoji: "🍛", from: "#ffe8cc", to: "#ffd8a8" },
  { match: /pizza/i, emoji: "🍕", from: "#ffe3e0", to: "#ffc9c2" },
  { match: /burger/i, emoji: "🍔", from: "#fff3bf", to: "#ffe066" },
  { match: /dosa|idli|vada|uttapam/i, emoji: "🥞", from: "#fff0d9", to: "#ffdfb0" },
  { match: /momo|dumpling/i, emoji: "🥟", from: "#f3ecff", to: "#e3d5ff" },
  { match: /noodle|chowmein|hakka|maggi/i, emoji: "🍜", from: "#ffe8d9", to: "#ffd0b5" },
  { match: /thali|meal|combo/i, emoji: "🍽️", from: "#e8f7ee", to: "#c9ecd7" },
  { match: /paneer|tikka|kebab|tandoor/i, emoji: "🍢", from: "#ffe0e9", to: "#ffc2d4" },
  { match: /chicken|butter/i, emoji: "🍗", from: "#ffeeda", to: "#ffddb3" },
  { match: /cake|pastry|dessert|brownie|gulab|sweet/i, emoji: "🍰", from: "#ffe6f0", to: "#ffc9e0" },
  { match: /coffee|latte|cappuccino|tea|chai/i, emoji: "☕", from: "#f0e6de", to: "#e0cfc0" },
  { match: /salad|healthy|bowl/i, emoji: "🥗", from: "#e6f7e6", to: "#c8ecc8" },
  { match: /shawarma|roll|wrap|frankie/i, emoji: "🌯", from: "#fff1dc", to: "#ffe1b8" },
  { match: /samosa|pakora|chaat|bhel|pani/i, emoji: "🥙", from: "#fdf2d0", to: "#f9e29c" },
  { match: /sandwich|toast/i, emoji: "🥪", from: "#fdeee0", to: "#f9d9bd" },
  { match: /juice|shake|smoothie|lassi/i, emoji: "🥤", from: "#e3f4ff", to: "#c2e5ff" },
  { match: /fish|prawn|seafood/i, emoji: "🐟", from: "#e0f2f7", to: "#bfe3ee" },
  { match: /egg|omelette/i, emoji: "🍳", from: "#fff8d6", to: "#ffef9e" },
];

// Warm fallback palette, cycled deterministically by name.
const FALLBACKS = [
  { emoji: "🍲", from: "#ffe8cc", to: "#ffd8a8" },
  { emoji: "🍱", from: "#f0e6de", to: "#e2d0be" },
  { emoji: "🫕", from: "#ffe3e0", to: "#ffc9c2" },
];

function hashCode(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export function dishVisual(name: string) {
  return (
    VISUALS.find((v) => v.match.test(name)) ??
    FALLBACKS[hashCode(name) % FALLBACKS.length]!
  );
}

export function DishArt({
  name,
  image,
  size = 48,
  className = "",
  fill = false,
}: {
  name: string;
  image?: string;
  size?: number;
  className?: string;
  /** Drop the fixed square and let the caller size it — for banner/hero use. */
  fill?: boolean;
}) {
  const [imgError, setImgError] = useState(false);
  const v = dishVisual(name);

  if (image && !imgError) {
    return (
      <Image
        src={image}
        alt={name}
        width={fill ? 400 : size}
        height={fill ? 400 : size}
        unoptimized
        onError={() => setImgError(true)}
        className={
          fill ? `object-cover ${className}` : `shrink-0 rounded-2xl object-cover ${className}`
        }
        style={fill ? undefined : { width: size, height: size }}
      />
    );
  }

  return (
    <span
      aria-hidden
      className={
        fill
          ? `flex items-center justify-center ${className}`
          : `flex shrink-0 items-center justify-center rounded-2xl ${className}`
      }
      style={{
        ...(fill ? {} : { width: size, height: size }),
        // In banner use the glyph IS the image, so it should fill the frame
        // rather than float in it. The square thumbnail keeps its tighter ratio.
        fontSize: fill ? 104 : Math.round(size * 0.52),
        background: `linear-gradient(135deg, ${v.from}, ${v.to})`,
      }}
    >
      {v.emoji}
    </span>
  );
}
