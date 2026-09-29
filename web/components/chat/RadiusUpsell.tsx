"use client";

import { useEffect, useState } from "react";
import { Tag, Award, Zap, Gift } from "lucide-react";
import { api } from "@/lib/api";

type PlusStatus = {
  active: boolean;
  pricePaise: number;
  perks: string[];
};

// Shown once per result to free users, outlining the benefits of upgrading.
// Disappears completely if the user is already subscribed, or if the status
// fetch fails (so it doesn't flash on a slow connection for a subscriber).
/**
 * One request per page, however many results are on it.
 *
 * This renders once under every recommendation, so a conversation with ten
 * results asked the same question ten times. The promise is shared, so the
 * first card to mount fetches and the rest read the same answer. Cleared on a
 * failure so a later card can try again rather than caching the outage.
 */
let statusRequest: Promise<PlusStatus> | null = null;

function subscriptionStatus(): Promise<PlusStatus> {
  statusRequest ??= api<PlusStatus>("/api/subscription").catch((err) => {
    statusRequest = null;
    throw err;
  });
  return statusRequest;
}

export function RadiusUpsell() {
  const [status, setStatus] = useState<PlusStatus | null>(null);

  useEffect(() => {
    let active = true;
    subscriptionStatus()
      .then((res) => {
        if (active) setStatus(res);
      })
      .catch(() => {
        // Fail silent: safe default is to hide the upsell rather than show it
        // to someone who might already be paying for it.
      });
    return () => {
      active = false;
    };
  }, []);

  // Show nothing while loading, or if active.
  if (!status || status.active) return null;

  return (
    <div className="mt-4 rounded-card border border-accent/30 bg-accent-soft/40 p-4">
      <div className="mb-3">
        <h3 className="text-[15px] font-bold text-ink">Unlock more with Radius</h3>
        <p className="text-[13px] text-cocoa">Get the best prices, fastest delivery and exclusive offers.</p>
      </div>
      
      <div className="mb-4 grid grid-cols-2 gap-2">
        <div className="flex items-center gap-1.5 text-[12px] font-medium text-ink">
          <Tag size={14} className="text-accent" /> Best Prices
        </div>
        <div className="flex items-center gap-1.5 text-[12px] font-medium text-ink">
          <Award size={14} className="text-accent" /> Top Rated
        </div>
        <div className="flex items-center gap-1.5 text-[12px] font-medium text-ink">
          <Zap size={14} className="text-accent" /> Fast Delivery
        </div>
        <div className="flex items-center gap-1.5 text-[12px] font-medium text-ink">
          <Gift size={14} className="text-accent" /> Great Offers
        </div>
      </div>

      <button className="tap-target w-full rounded-pill bg-accent py-2.5 text-[14px] font-bold text-white transition-colors hover:bg-accent/90">
        Explore More Options
      </button>
    </div>
  );
}
