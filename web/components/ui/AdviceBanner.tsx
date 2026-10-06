import { Clock3, TrendingDown, CloudRain } from "lucide-react";
import { cn } from "@/lib/cn";
import { rupeesApprox } from "@/lib/money";

export type Advice = {
  action: "order_now" | "wait";
  message: string;
  expectedSavingPaise?: number;
  waitMinutes?: number;
  contextNote?: string;
};

// The timing advisor's verdict: order now, or hold off.
//
// The advisor has always computed how much waiting would save and for how
// long, and this card used to render neither. It said "worth waiting" and left
// the reader to decide on nothing. The number is the entire argument, so it
// now leads: a saving worth ₹40 in twelve minutes is a decision somebody can
// actually make, where "prices may drop" is a horoscope.
//
// The flat tinted box became a gradient with the icon in its own chip, and a
// rail down the left edge. That reads as a verdict from the engine rather than
// as another notice among the notices, which is what it looked like sitting
// under two other tinted paragraphs.

export function AdviceBanner({
  advice,
  className,
}: {
  advice: Advice;
  className?: string;
}) {
  const wait = advice.action === "wait";
  const Icon = wait ? TrendingDown : Clock3;

  // Only shown when it is worth the space. "Save ₹0" or "wait 0 minutes" is
  // noise dressed as a recommendation.
  const saving =
    advice.expectedSavingPaise && advice.expectedSavingPaise >= 500
      ? rupeesApprox(advice.expectedSavingPaise)
      : null;
  // Minutes past an hour and a half stop being a useful unit: "in about 180
  // min" is a number the reader has to convert, and the sentence underneath
  // already says three hours.
  const wallClock = (() => {
    const m = advice.waitMinutes;
    if (!m || m <= 0) return null;
    if (m < 90) return `${m} min`;
    const hours = Math.round(m / 60);
    return `${hours} hr${hours === 1 ? "" : "s"}`;
  })();

  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-card border pl-4 pr-3.5 py-3",
        // The rail carries the verdict's colour, so the fill can stay light
        // enough for the text on it to be comfortable.
        "before:absolute before:inset-y-0 before:left-0 before:w-1",
        wait
          ? "border-accent/30 bg-gradient-to-br from-accent-soft/70 to-accent-soft/20 before:bg-accent"
          : "border-success/25 bg-gradient-to-br from-success-soft to-success-soft/25 before:bg-success",
        className,
      )}
    >
      <div className="flex items-start gap-3">
        <span
          className={cn(
            "mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full",
            wait ? "bg-accent/15 text-accent" : "bg-success/15 text-success",
          )}
        >
          <Icon size={16} />
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <p
              className={cn(
                "text-[11px] font-bold uppercase tracking-wide",
                wait ? "text-accent" : "text-success",
              )}
            >
              {wait ? "Worth waiting" : "Good time to order"}
            </p>
            {/* The figure the advice turns on, stated rather than implied. */}
            {wait && saving && (
              <p className="text-[15px] font-bold text-ink">
                Save {saving} more by waiting
                {wallClock && (
                  <span className="ml-1 text-[12px] font-medium text-cocoa">
                    ~{wallClock}
                  </span>
                )}
              </p>
            )}
          </div>

          <p className="mt-1 text-[13px] leading-relaxed text-ink">
            {advice.message}
          </p>

          {advice.contextNote && (
            <p className="mt-1.5 flex items-start gap-1.5 text-[12px] leading-relaxed text-cocoa">
              <CloudRain size={13} className="mt-0.5 shrink-0 text-accent" />
              {advice.contextNote}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
