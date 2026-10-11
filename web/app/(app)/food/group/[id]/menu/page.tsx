"use client";

import { use, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Plus, Sparkles, Star, Search, ShoppingBag, Check } from "lucide-react";
import { api } from "@/lib/api";
import { rupees } from "@/lib/money";
import { Card } from "@/components/ui/Card";
import { GroupHeader, MemberStrip } from "@/components/food/GroupHeader";
import { DishArt } from "@/components/food/DishArt";
import type { GroupCart, GroupSuggestion } from "@/components/food/GroupCartTypes";
import type { FoodQuote } from "@/components/chat/types";
import { useI18n } from "@/components/i18n/I18nContext";
import { useToast } from "@/components/ui/Toast";
import { FadeIn, SlideIn } from "@/components/ui/motion";
import { cn } from "@/lib/cn";

// Figma "Paradise Biryani" group menu: who is here, the categories, and the
// list everyone is ordering from — plus the suggestion card, which appears only
// when the server has actually found a cheaper pack that feeds this group.
//
// The categories are derived from what the platform sells rather than hardcoded,
// so a chip is never a promise of a section that turns out to be empty.

const POLL_MS = 5000;

const CATEGORIES: { key: string; labelKey: string; match: string[] }[] = [
  { key: "biryani", labelKey: "grp.catBiryani", match: ["biryani"] },
  { key: "starters", labelKey: "grp.catStarters", match: ["momos", "roll", "burger"] },
  { key: "mains", labelKey: "grp.catMains", match: ["thali", "pasta", "pizza", "dosa", "bowl"] },
  { key: "desserts", labelKey: "grp.catDesserts", match: ["dessert", "cake", "sweet"] },
];

export default function GroupMenuPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const { t } = useI18n();
  const { toast } = useToast();
  const [cart, setCart] = useState<GroupCart | null>(null);
  const [quotes, setQuotes] = useState<FoodQuote[]>([]);
  const [suggestion, setSuggestion] = useState<GroupSuggestion | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [category, setCategory] = useState<string>("");
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);

  // Bumped on either side of every change this device makes; a poll that was
  // already in flight answers with the cart as it was before and used to
  // overwrite the fresh one, so the count on the cart button dropped back for
  // a poll after each Add.
  const writes = useRef(0);

  const load = useCallback(() => {
    const at = writes.current;
    api<GroupCart>(`/api/groups/${id}`)
      .then((c) => {
        if (writes.current === at) setCart(c);
      })
      .catch(() => {});
    api<{ suggestion: GroupSuggestion | null }>(`/api/groups/${id}/suggestion`)
      .then((d) => {
        if (writes.current === at) setSuggestion(d.suggestion);
      })
      .catch(() => {
        if (writes.current === at) setSuggestion(null);
      });
  }, [id]);

  useEffect(() => {
    load();
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  // The menu is whatever this cart's platform sells. Searching narrows it;
  // an empty box shows everything, which is what a menu is.
  const platform = cart?.platform;
  useEffect(() => {
    if (!platform) return;
    const term = query.trim();
    const timer = setTimeout(
      () => {
        api<{ quotes: FoodQuote[] }>(
          `/api/food/search${term ? `?q=${encodeURIComponent(term)}` : ""}`,
        )
          .then((d) => setQuotes(d.quotes.filter((q) => q.platform === platform)))
          .catch(() => setQuotes([]));
      },
      term ? 250 : 0,
    );
    return () => clearTimeout(timer);
  }, [query, platform]);

  const shown = useMemo(() => {
    if (!category) return quotes;
    const cat = CATEGORIES.find((c) => c.key === category);
    if (!cat) return quotes;
    return quotes.filter((q) =>
      cat.match.some((m) => q.name.toLowerCase().includes(m) || q.dishId.includes(m)),
    );
  }, [quotes, category]);

  // Only offer a chip that would actually show something.
  const categories = useMemo(
    () =>
      CATEGORIES.filter((c) =>
        quotes.some((q) => c.match.some((m) => q.name.toLowerCase().includes(m) || q.dishId.includes(m))),
      ),
    [quotes],
  );

  async function add(dishId: string) {
    setAdding(dishId);
    writes.current += 1;
    try {
      setCart(
        await api<GroupCart>(`/api/groups/${id}/items`, {
          method: "POST",
          json: { dishId, qty: 1 },
        }),
      );
      writes.current += 1;
      load();
    } catch (e) {
      writes.current += 1;
      toast(e instanceof Error ? e.message : t("grp.addFailed"));
    } finally {
      setAdding(null);
    }
  }

  async function applyDeal() {
    setApplying(true);
    writes.current += 1;
    try {
      const d = await api<{ applied: number; cart: GroupCart }>(
        `/api/groups/${id}/suggestion/apply`,
        { method: "POST", json: {} },
      );
      writes.current += 1;
      setCart(d.cart);
      setSuggestion(null);
      toast(t("grp.dealApplied").replace("{amount}", rupees(d.applied)));
    } catch (e) {
      toast(e instanceof Error ? e.message : t("grp.dealFailed"));
      writes.current += 1;
      load();
    } finally {
      setApplying(false);
    }
  }

  const itemCount = cart?.items.reduce((s, i) => s + i.qty, 0) ?? 0;

  return (
    <div className="mx-auto w-full max-w-xl px-4 pb-28 lg:max-w-3xl lg:px-6 lg:pb-10">
      <GroupHeader
        title={cart?.name ?? t("grp.menuTitle")}
        subtitle={t("grp.groupMenu")}
        backTo={`/food/group/${id}`}
        chatHref={`/food/group/${id}/chat`}
      />

      {/* Who is here */}
      {cart && (
        <div className="flex items-center justify-between">
          <MemberStrip members={cart.members} />
          <span className="text-[13px] font-bold text-accent">
            {t("grp.memberCount").replace("{n}", String(cart.members.length))}
          </span>
        </div>
      )}

      {/* The group deal. Shown only when the server found one, which is rarely
          — a card that appears on every cart teaches people to dismiss it. */}
      {suggestion && !dismissed && (
        <SlideIn direction="top">
          <Card className="mt-4 border border-accent/25">
            <p className="flex items-center gap-1.5 text-[14px] font-extrabold text-ink">
              <Sparkles size={15} className="text-accent" /> {t("grp.dealHi")}
            </p>
            <p className="mt-1 text-[13px] leading-relaxed text-cocoa">
              {t("grp.dealBlurb")
                .replace("{n}", String(suggestion.peopleAgreeing))
                .replace("{theme}", suggestion.theme)}
            </p>

            <div className="mt-3 rounded-[18px] border border-line bg-cream/60 p-3.5">
              <div className="flex items-start gap-3">
                <DishArt name={suggestion.name} className="size-14 shrink-0 rounded-[14px]" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[15px] font-bold text-ink">{suggestion.name}</p>
                  <p className="text-[12px] text-cocoa">
                    {t("grp.serves").replace("{n}", String(suggestion.serves))}
                  </p>
                  <p className="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                    <span className="text-[17px] font-extrabold text-ink">
                      {rupees(suggestion.packPaise)}
                    </span>
                    <span className="text-[12px] text-cocoa line-through">
                      {rupees(suggestion.currentPaise)}
                    </span>
                    <span className="rounded-pill bg-success/12 px-2 py-0.5 text-[11px] font-bold text-success">
                      {t("grp.save").replace("{amount}", rupees(suggestion.savingPaise))}
                    </span>
                  </p>
                </div>
              </div>

              {suggestion.includes.length > 0 && (
                <>
                  <p className="mt-3 text-[12px] font-bold text-ink">{t("grp.includes")}</p>
                  <ul className="mt-1.5 flex flex-col gap-1">
                    {suggestion.includes.map((line) => (
                      <li key={line} className="flex items-center gap-2 text-[12px] text-cocoa">
                        <Check size={13} className="shrink-0 text-success" />
                        {line}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>

            {cart?.isHost ? (
              <div className="mt-3.5 flex flex-col gap-2 sm:flex-row">
                <button
                  onClick={() => setDismissed(true)}
                  className="tap-target h-[46px] flex-1 rounded-pill border border-line bg-card text-[14px] font-bold text-cocoa transition-colors hover:bg-beige/40"
                >
                  {t("grp.keepCurrent")}
                </button>
                <button
                  onClick={applyDeal}
                  disabled={applying}
                  className="tap-target h-[46px] flex-1 rounded-pill border border-accent bg-accent-soft text-[14px] font-bold text-accent-ink transition-colors hover:bg-accent hover:text-white disabled:opacity-60"
                >
                  {applying ? t("grp.applying") : t("grp.applyAndSave")}
                </button>
              </div>
            ) : (
              // It deletes other people's items, so only the host may take it.
              <p className="mt-3 text-[12px] text-cocoa">{t("grp.hostDecides")}</p>
            )}
          </Card>
        </SlideIn>
      )}

      {/* Search + categories */}
      <div className="mt-4 flex items-center gap-2 rounded-pill bg-card px-3.5 py-2.5 shadow-soft">
        <Search size={16} className="shrink-0 text-cocoa" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("grp.searchMenu")}
          className="min-w-0 flex-1 bg-transparent text-[14px] text-ink outline-none placeholder:text-cocoa/60"
        />
      </div>

      {categories.length > 0 && (
        <div className="-mx-4 mt-3 flex gap-2 overflow-x-auto px-4 pb-1 lg:mx-0 lg:px-0">
          <Chip active={category === ""} onClick={() => setCategory("")} label={t("grp.catAll")} />
          {categories.map((c) => (
            <Chip
              key={c.key}
              active={category === c.key}
              onClick={() => setCategory(c.key)}
              label={t(c.labelKey as never)}
            />
          ))}
        </div>
      )}

      <h2 className="mt-5 flex items-center gap-1.5 text-[15px] font-extrabold text-ink">
        <span className="size-1.5 rounded-full bg-accent" />
        {t("grp.recommended")}
      </h2>

      <FadeIn className="mt-3 flex flex-col gap-3">
        {shown.length === 0 && (
          <p className="py-6 text-center text-[13px] text-cocoa">{t("grp.nothingHere")}</p>
        )}
        {shown.map((q) => {
          const mine = cart?.items.filter((i) => i.dishId === q.dishId) ?? [];
          return (
            <div key={q.dishId} className="flex items-center gap-3 rounded-[18px] bg-card p-3 shadow-soft">
              <DishArt name={q.name} className="size-[68px] shrink-0 rounded-[14px]" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[15px] font-bold text-ink">{q.name}</p>
                <p className="mt-0.5 flex items-center gap-1 text-[12px] text-cocoa">
                  <Star size={11} className="fill-warning text-warning" />
                  {q.rating} · {q.restaurant}
                </p>
                <p className="mt-1 text-[16px] font-extrabold text-ink">
                  {rupees(q.effectivePaise)}
                </p>
              </div>
              <button
                onClick={() => add(q.dishId)}
                disabled={adding === q.dishId || cart?.status !== "open"}
                aria-label={t("grp.addDish").replace("{name}", q.name)}
                className="tap-target relative flex size-9 shrink-0 items-center justify-center rounded-full bg-accent text-white transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                <Plus size={17} />
                {mine.length > 0 && (
                  <span className="absolute -right-1 -top-1 flex min-w-[16px] items-center justify-center rounded-full border-2 border-card bg-ink-fill px-1 text-[9px] font-bold text-white">
                    {mine.reduce((s, i) => s + i.qty, 0)}
                  </span>
                )}
              </button>
            </div>
          );
        })}
      </FadeIn>

      {/* Sticky cart bar — the design's dark bar with the running total */}
      {itemCount > 0 && (
        <div className="fixed inset-x-0 bottom-16 z-20 mx-auto max-w-xl px-4 lg:static lg:mt-6 lg:max-w-none lg:px-0">
          <Link
            href={`/food/group/${id}/cart`}
            className="flex h-[58px] items-center gap-3 rounded-[22px] bg-accent px-4 text-white shadow-card transition-colors hover:bg-[#d4570f]"
          >
            <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-white/15">
              <ShoppingBag size={17} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[12px] text-white/85">
                {t("grp.itemsAdded").replace("{n}", String(itemCount))}
              </span>
              <span className="block text-[14px] font-bold">{t("grp.viewCart")}</span>
            </span>
            <span className="shrink-0 rounded-pill bg-white px-3.5 py-1.5 text-[15px] font-extrabold text-accent">
              {rupees(cart?.totalPaise ?? 0)}
            </span>
          </Link>
        </div>
      )}
    </div>
  );
}

function Chip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "tap-target shrink-0 rounded-pill px-4 py-2 text-[13px] font-semibold transition-colors",
        active ? "bg-accent text-white" : "bg-card text-cocoa shadow-soft hover:bg-beige/50",
      )}
    >
      {label}
    </button>
  );
}
