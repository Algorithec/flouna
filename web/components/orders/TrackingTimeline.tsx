"use client";

import { useI18n } from "@/components/i18n/I18nContext";
import { CheckCircle2, Loader2 } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { cn } from "@/lib/cn";

export type TrackingEvent = { id: string; status: string; message: string; createdAt: string };

// Live order/ride progress. The flat checklist this replaces couldn't answer
// the only question a waiting customer actually has — "how long?" — so the
// header is a countdown to the next step, the current step is visibly active,
// and finished steps carry a relative time.

function minutesUntil(target: number, now: number): number {
  return Math.max(0, Math.ceil((target - now) / 60_000));
}

function relativeTime(then: number, now: number): string {
  const mins = Math.floor((now - then) / 60_000);
  if (mins < 1) return "just now";
  if (mins === 1) return "1 min ago";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  return hrs === 1 ? "1 hour ago" : `${hrs} hours ago`;
}

export function TrackingTimeline({
  events,
  domain,
  now,
  title,
}: {
  events: TrackingEvent[];
  domain: string;
  now: number;
  title: string;
}) {
  const { t } = useI18n();
  if (events.length === 0) return null;

  const times = events.map((e) => new Date(e.createdAt).getTime());
  const reachedCount = times.filter((t) => t <= now).length;
  const allDone = reachedCount === events.length;
  const isFood = domain === "food";

  // The step being worked on right now, and when it should finish.
  const activeIndex = allDone ? events.length - 1 : reachedCount;
  const nextAt = times[activeIndex];
  const etaMinutes = nextAt !== undefined ? minutesUntil(nextAt, now) : 0;

  // Progress across the whole timeline, so the bar moves smoothly between
  // steps rather than jumping only when one completes.
  const start = times[0] ?? now;
  const end = times[times.length - 1] ?? now;
  const span = Math.max(1, end - start);
  const progress = allDone
    ? 100
    : Math.min(100, Math.max(0, ((now - start) / span) * 100));

  return (
    <Card className="mt-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-[14px] font-bold text-ink">{title}</h2>
          {!allDone && (
            <p className="mt-0.5 text-[12px] text-cocoa">
              {isFood ? t("tt.estDelivery") : t("tt.estPickup")} ·{" "}
              <span className="font-semibold text-accent">
                {etaMinutes === 0 ? t("tt.anyMoment") : `~${etaMinutes} min`}
              </span>
            </p>
          )}
        </div>
        {!allDone && (
          <span className="flex shrink-0 items-center gap-1.5 rounded-pill bg-accent-soft px-2.5 py-1 text-[11px] font-bold text-accent">
            <Loader2 size={11} className="animate-spin" />
            {t("tt.live")}
          </span>
        )}
      </div>

      {/* Progress bar */}
      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-beige">
        <div
          className={cn(
            "h-full rounded-full transition-[width] duration-1000 ease-linear",
            allDone ? "bg-success" : "bg-accent",
          )}
          style={{ width: `${progress}%` }}
        />
      </div>

      <div className="mt-4 flex flex-col">
        {events.map((e, i) => {
          const at = times[i]!;
          const isReached = at <= now;
          const isActive = !allDone && i === activeIndex;
          const isLast = i === events.length - 1;
          return (
            <div key={e.id} className="flex gap-3">
              <div className="flex flex-col items-center">
                {isReached ? (
                  <CheckCircle2 size={18} className="shrink-0 text-success" />
                ) : isActive ? (
                  // The step in progress — a pulsing ring reads as "happening
                  // now" without needing to say it.
                  <span className="relative flex size-[18px] shrink-0 items-center justify-center">
                    <span className="absolute inline-flex size-full animate-ping rounded-full bg-accent/40" />
                    <span className="relative size-2.5 rounded-full bg-accent" />
                  </span>
                ) : (
                  <span className="size-[18px] shrink-0 rounded-full border-2 border-line" />
                )}
                {!isLast && (
                  <span
                    className={cn(
                      "w-px flex-1",
                      isReached ? "bg-success/50" : "bg-line",
                    )}
                  />
                )}
              </div>

              <div className={cn("pb-5", !isReached && !isActive && "opacity-45")}>
                <p
                  className={cn(
                    "text-[13px]",
                    isActive ? "font-bold text-accent" : "font-semibold text-ink",
                  )}
                >
                  {e.message}
                </p>
                <p className="text-[11px] text-cocoa">
                  {isReached
                    ? relativeTime(at, now)
                    : isActive
                      ? minutesUntil(at, now) === 0
                        ? t("tt.anyMoment")
                        : `in ~${minutesUntil(at, now)} min`
                      : new Date(at).toLocaleTimeString("en-IN", {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                </p>
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}
