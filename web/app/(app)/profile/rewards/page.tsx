"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useBackTo } from "@/lib/navHistory";
import { ArrowLeft, Gift, ReceiptText, CircleHelp, ChevronRight } from "lucide-react";
import { api } from "@/lib/api";
import { rupees } from "@/lib/money";
import { useToast } from "@/components/ui/Toast";
import { useI18n } from "@/components/i18n/I18nContext";
import { FadeIn, Stagger, StaggerItem } from "@/components/ui/motion";
import { cn } from "@/lib/cn";

// Figma "Offers & Rewards": a balance hero, the offers the buyer can actually
// use, then Reward History and How it works.
//
// The balance is the rewards wallet's real ledger sum, and the offers are the
// live coupon rows — nothing on this screen is a display number. "Apply" puts
// the code on the clipboard and remembers it, so the next checkout picks it up
// rather than making the buyer retype it.

type Coupon = { code: string; description: string; minOrderPaise: number };

/** The short badge the design puts in the tile: F100, R50, NEW. */
function badgeFor(code: string) {
  const upper = code.toUpperCase();
  const digits = upper.match(/\d+/)?.[0];
  // Wordmark codes (NEWUSER) get their first syllable; numbered ones get the
  // initial plus the number, which is what makes F100 and R50 readable.
  if (!digits) return upper.slice(0, 3);
  return `${upper[0]}${digits}`;
}

export default function RewardsPage() {
  const goBack = useBackTo("/profile");
  const { toast } = useToast();
  const { t } = useI18n();
  const [balancePaise, setBalancePaise] = useState<number | null>(null);
  const [coupons, setCoupons] = useState<Coupon[] | null>(null);
  const [applied, setApplied] = useState<string | null>(null);

  const load = useCallback(() => {
    api<{ balancePaise: number }>("/api/users/wallet")
      .then((d) => setBalancePaise(d.balancePaise))
      .catch(() => setBalancePaise(0));
    // Food and rides run separate coupon pools; this screen is the account-wide
    // view, so it shows both rather than pretending one of them is everything.
    Promise.all([
      api<{ coupons: Coupon[] }>("/api/coupons?domain=food").catch(() => ({ coupons: [] })),
      api<{ coupons: Coupon[] }>("/api/coupons?domain=ride").catch(() => ({ coupons: [] })),
    ])
      .then(([food, ride]) => {
        const seen = new Set<string>();
        setCoupons(
          [...food.coupons, ...ride.coupons].filter((c) =>
            seen.has(c.code) ? false : (seen.add(c.code), true),
          ),
        );
      })
      .catch(() => setCoupons([]));
  }, []);
  useEffect(load, [load]);

  // Read in an async task, not in the effect body: local storage is an
  // external store, and setting state synchronously here cascades a second
  // render before the first has painted.
  useEffect(() => {
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (cancelled) return;
      try {
        setApplied(localStorage.getItem("flouna.coupon"));
      } catch {
        // Storage unavailable — the code simply isn't remembered.
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  function apply(code: string) {
    // Remembered for checkout, which re-validates it server-side; the copy is
    // the fallback for anyone who'd rather paste it themselves.
    try {
      localStorage.setItem("flouna.coupon", code);
    } catch {
      // Not fatal — the toast still tells them the code.
    }
    void navigator.clipboard?.writeText(code).catch(() => {});
    setApplied(code);
    toast(`${code} ${t("pp.rew.savedForNext")}`);
  }

  return (
    <div className="min-h-dvh bg-acct-bg">
      <div className="mx-auto w-full max-w-xl px-4 pb-10 lg:max-w-[780px] lg:px-6">
        <div className="flex items-center py-4">
          <button
            onClick={goBack}
            aria-label={t("common.back")}
            className="tap-target flex size-9 shrink-0 items-center justify-center rounded-full bg-card shadow-soft transition-colors hover:bg-acct-bg"
          >
            <ArrowLeft size={18} className="text-acct-ink" />
          </button>
          <h1 className="flex-1 pr-9 text-center text-[17px] font-extrabold text-acct-ink">
            {t("pp.profile.rewards")}
          </h1>
        </div>

        {/* Balance hero */}
        <FadeIn y={10}>
          <div
            className="relative overflow-hidden rounded-[18px] p-5 text-white shadow-lift"
            style={{ background: "linear-gradient(135deg, #e8651a 0%, #b33b06 100%)" }}
          >
            <p className="text-[13px] font-medium text-white/80">{t("pp.rew.yourBalance")}</p>
            <p className="mt-1 text-[32px] font-extrabold leading-none">
              {balancePaise === null ? "..." : rupees(balancePaise)}
            </p>
            <p className="mt-1.5 text-[12px] text-white/70">{t("pp.rew.walletBalance")}</p>
            <Gift
              size={92}
              className="pointer-events-none absolute -right-2 top-1/2 -translate-y-1/2 text-white/25"
              aria-hidden
            />
          </div>
        </FadeIn>

        <p className="mb-2 mt-6 px-1 text-[13px] font-semibold text-acct-muted">
          {t("pp.rew.available")}
        </p>

        <Stagger className="overflow-hidden rounded-[18px] bg-card shadow-soft">
          {coupons === null ? (
            <p className="px-4 py-8 text-center text-[13px] text-acct-muted">
              {t("common.loading")}
            </p>
          ) : coupons.length === 0 ? (
            <p className="px-4 py-8 text-center text-[13px] text-acct-muted">
              {t("pp.rew.noOffers")}
            </p>
          ) : (
            coupons.map((c, i) => (
              <StaggerItem key={c.code}>
                <div
                  className={cn(
                    "flex items-center gap-3 px-4 py-3.5",
                    i < coupons.length - 1 && "border-b border-line",
                  )}
                >
                  <span className="flex h-11 w-12 shrink-0 items-center justify-center rounded-[10px] bg-acct-tint text-[12px] font-extrabold text-acct-accent">
                    {badgeFor(c.code)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[15px] font-bold text-acct-ink">
                      {c.code}
                    </span>
                    <span className="line-clamp-2 text-[12px] text-acct-muted">
                      {c.description}
                    </span>
                    {c.minOrderPaise > 0 && (
                      <span className="mt-0.5 block text-[11px] text-acct-muted">
                        {t("pp.rew.minOrder")} {rupees(c.minOrderPaise)}
                      </span>
                    )}
                  </span>
                  <button
                    onClick={() => apply(c.code)}
                    className={cn(
                      "tap-target shrink-0 rounded-pill border px-4 py-1.5 text-[13px] font-bold transition-colors",
                      applied === c.code
                        ? "border-success bg-success/10 text-success"
                        : "border-acct-accent text-acct-accent hover:bg-acct-tint",
                    )}
                  >
                    {applied === c.code ? t("pp.rew.applied") : t("pp.rew.apply")}
                  </button>
                </div>
              </StaggerItem>
            ))
          )}
        </Stagger>

        <div className="mt-5 overflow-hidden rounded-[18px] bg-card shadow-soft">
          <Link
            href="/profile/rewards/history"
            className="flex items-center gap-3.5 border-b border-line px-4 py-3.5 transition-colors hover:bg-acct-bg"
          >
            <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-acct-tint">
              <ReceiptText size={18} className="text-acct-accent" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[15px] font-bold text-acct-ink">
                {t("pp.rew.history")}
              </span>
              <span className="block text-[12px] text-acct-muted">
                {t("pp.rew.historySub")}
              </span>
            </span>
            <ChevronRight size={17} className="shrink-0 text-acct-muted" />
          </Link>
          <Link
            href="/profile/rewards/how-it-works"
            className="flex items-center gap-3.5 px-4 py-3.5 transition-colors hover:bg-acct-bg"
          >
            <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-acct-tint">
              <CircleHelp size={18} className="text-acct-accent" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[15px] font-bold text-acct-ink">
                {t("pp.rew.how")}
              </span>
              <span className="block text-[12px] text-acct-muted">
                {t("pp.rew.howSub")}
              </span>
            </span>
            <ChevronRight size={17} className="shrink-0 text-acct-muted" />
          </Link>
        </div>
      </div>
    </div>
  );
}
