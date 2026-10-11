"use client";

import { useEffect, useState } from "react";
import { CloudRain, TrendingUp, ChevronRight } from "lucide-react";
import { api } from "@/lib/api";
import { cn } from "@/lib/cn";

// A proactive heads-up the engine surfaces before the user asks — e.g. rain
// near their usual morning ride. Built from the decision profile + live context
// (server-side). Silent when there's nothing worth saying.
type Prediction = {
  kind: "ride_routine_weather" | "ride_routine_surge";
  severity: "info" | "warning";
  title: string;
  message: string;
  drop: string;
  typicalHour: number;
  leadMinutes: number;
};

export function PredictionBanner({
  onBook,
}: {
  // Called when the user taps the heads-up — prefill a ride to the routine drop.
  onBook: (drop: string) => void;
}) {
  const [pred, setPred] = useState<Prediction | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Sharpen weather with the user's location when they allow it; otherwise the
    // server falls back to the city centre. Never blocks the screen.
    const load = (lat?: number, lng?: number) => {
      const qs = lat != null && lng != null ? `?lat=${lat}&lng=${lng}` : "";
      api<{ predictions: Prediction[] }>(`/api/users/predictions${qs}`)
        .then((d) => !cancelled && setPred(d.predictions[0] ?? null))
        .catch(() => {
          /* no heads-up is fine */
        });
    };
    if (typeof navigator !== "undefined" && navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (p) => load(p.coords.latitude, p.coords.longitude),
        () => load(),
        { timeout: 2000, maximumAge: 600000 },
      );
    } else {
      load();
    }
    return () => {
      cancelled = true;
    };
  }, []);

  if (!pred) return null;

  const warning = pred.severity === "warning";
  const Icon = pred.kind === "ride_routine_weather" ? CloudRain : TrendingUp;

  return (
    <button
      onClick={() => onBook(pred.drop)}
      className={cn(
        "flex w-full items-start gap-3 rounded-card border px-4 py-3 text-left transition-colors",
        warning
          ? "border-accent/50 bg-accent-soft/70 hover:bg-accent-soft"
          : // Tinted from the navy token rather than a fixed pale blue. The
            // literal kept its light value in dark mode, so the title and
            // message — both token colours, both near-white there — sat on an
            // almost-white band at roughly 1.1:1.
            "border-navy/15 bg-navy/10 hover:bg-navy/15",
      )}
    >
      <span
        className={cn(
          "mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full",
          warning ? "bg-accent/15 text-accent" : "bg-navy/10 text-navy",
        )}
      >
        <Icon size={15} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] font-bold text-ink">{pred.title}</span>
        <span className="mt-0.5 block text-[12px] leading-relaxed text-cocoa">
          {pred.message}
        </span>
      </span>
      <ChevronRight size={16} className="mt-0.5 shrink-0 text-cocoa/50" />
    </button>
  );
}
