"use client";

// Choosing a dish's options (size, crust, toppings) before ordering it from
// an ONDC seller.
//
// The seller's options form a tree: the dish opens its first groups, and each
// choice can open more (a crust opens sizes, a size opens toppings). Which
// groups show depends on what is chosen, so they are worked out afresh from
// the choices every render. The server checks the same rules again before
// anything goes to the seller; this only keeps the customer from building a
// choice the seller would refuse.

import { useState } from "react";
import { Check } from "lucide-react";
import { rupees } from "@/lib/money";
import { cn } from "@/lib/cn";
import { useEscapeToClose } from "@/lib/useEscapeToClose";
import { useFocusTrap } from "@/lib/useFocusTrap";
import { useI18n } from "@/components/i18n/I18nContext";

export type OptionTree = {
  starts: string[];
  groups: Record<string, { id: string; name: string; min: number; max: number; seq: number; options: { id: string; name: string; pricePaise: number; isDefault: boolean; opens: string[] }[] }>;
};

type Group = OptionTree["groups"][string];

/** The groups open for these choices, in the order they open, and what is chosen in each. */
function resolve(tree: OptionTree, explicit: Record<string, string[]>) {
  const open: Group[] = [];
  const chosen: Record<string, string[]> = {};
  const seen = new Set<string>();
  const queue = [...tree.starts];
  while (queue.length) {
    const g = tree.groups[queue.shift()!];
    if (!g || seen.has(g.id)) continue;
    seen.add(g.id);
    open.push(g);
    // Untouched required groups start on the seller's defaults (or its first
    // options when it marked none), as many as the group needs.
    const defaults = g.options.filter((o) => o.isDefault);
    const pool = defaults.length ? defaults : g.options;
    const picks = explicit[g.id] ?? (g.min > 0 ? pool.slice(0, Math.min(g.min, g.max)).map((o) => o.id) : []);
    chosen[g.id] = picks;
    const next = g.options.filter((o) => picks.includes(o.id)).flatMap((o) => o.opens);
    queue.push(...[...next].sort((a, b) => (tree.groups[a]?.seq ?? 0) - (tree.groups[b]?.seq ?? 0)));
  }
  return { open, chosen };
}

export function OndcOptionsSheet({
  name,
  basePaise,
  tree,
  busy,
  failed,
  onOrder,
  onClose,
}: {
  name: string;
  basePaise: number;
  tree: OptionTree;
  busy: boolean;
  /** Why the last attempt to order did not start, or null. */
  failed: string | null;
  onOrder: (optionIds: string[]) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [explicit, setExplicit] = useState<Record<string, string[]>>({});
  useEscapeToClose(!busy, onClose);
  const sheet = useFocusTrap<HTMLDivElement>(true);
  const { open, chosen } = resolve(tree, explicit);
  const ids = open.flatMap((g) => chosen[g.id] ?? []);
  const valid = open.every((g) => (chosen[g.id]?.length ?? 0) >= g.min && (chosen[g.id]?.length ?? 0) <= g.max);
  const extra = open.flatMap((g) => g.options.filter((o) => chosen[g.id]?.includes(o.id))).reduce((s, o) => s + o.pricePaise, 0);

  const pick = (g: Group, id: string) => {
    const now = chosen[g.id] ?? [];
    // An optional single choice can be taken back: tapping it again clears it.
    // A required one stays chosen, as a radio does.
    const next =
      g.max === 1
        ? now.includes(id) && g.min === 0
          ? []
          : [id]
        : now.includes(id)
          ? now.filter((x) => x !== id)
          : now.length < g.max
            ? [...now, id]
            : now;
    setExplicit((e) => ({ ...e, [g.id]: next }));
  };
  const rule = (g: Group) =>
    g.min === g.max ? (g.max === 1 ? t("on.optChoose1") : t("on.optExact").replace("{n}", String(g.max))) : g.min === 0 ? t("on.optUpTo").replace("{n}", String(g.max)) : t("on.optRange").replace("{min}", String(g.min)).replace("{max}", String(g.max));

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center" onClick={() => !busy && onClose()}>
      <div
        ref={sheet}
        role="dialog"
        aria-modal="true"
        aria-labelledby="ondc-options-title"
        className="flex max-h-[88dvh] w-full max-w-md flex-col rounded-t-[22px] bg-card sm:rounded-[22px]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-5 pt-5">
          <h2 id="ondc-options-title" className="min-w-0 flex-1 truncate text-[16px] font-bold text-ink">
            {name}
          </h2>
          <button type="button" onClick={onClose} disabled={busy} className="tap-target shrink-0 rounded-pill px-3 py-1 text-[13px] font-semibold text-cocoa hover:bg-beige/60">
            {t("common.close")}
          </button>
        </div>
        <div className="mt-2 flex-1 space-y-4 overflow-y-auto px-5 pb-2">
          {open.map((g) => {
            const picks = chosen[g.id] ?? [];
            const full = g.max > 1 && picks.length >= g.max;
            return (
              <fieldset key={g.id}>
                <legend className="flex w-full items-baseline gap-2">
                  <span className="text-[14px] font-semibold text-ink">{g.name}</span>
                  <span className="ml-auto text-[11px] text-cocoa">{rule(g)}</span>
                </legend>
                <div className="mt-1.5 space-y-1.5">
                  {g.options.map((o) => {
                    const on = picks.includes(o.id);
                    return (
                      <button
                        key={o.id}
                        type="button"
                        role={g.max === 1 ? "radio" : "checkbox"}
                        aria-checked={on}
                        disabled={busy || (!on && full)}
                        onClick={() => pick(g, o.id)}
                        className={cn(
                          "tap-target flex w-full items-center gap-3 rounded-[12px] border px-3 py-2.5 text-left text-[14px] text-ink transition-colors disabled:opacity-50",
                          on ? "border-accent bg-accent-soft" : "border-line",
                        )}
                      >
                        <span className={cn("flex size-5 shrink-0 items-center justify-center border", g.max === 1 ? "rounded-full" : "rounded-md", on ? "border-accent bg-accent text-white" : "border-line")}>
                          {on && <Check size={13} />}
                        </span>
                        <span className="min-w-0 flex-1">{o.name}</span>
                        {o.pricePaise > 0 && <span className="shrink-0 text-[13px] text-cocoa">+{rupees(o.pricePaise)}</span>}
                      </button>
                    );
                  })}
                </div>
              </fieldset>
            );
          })}
        </div>
        <div className="border-t border-line px-5 pb-5 pt-3">
          <p className="text-[11px] text-cocoa">{t("on.optNote")}</p>
          {failed && <p className="mt-1 text-[12px] text-danger">{failed}</p>}
          <button
            type="button"
            disabled={!valid || busy}
            onClick={() => onOrder(ids)}
            className="tap-target mt-2 inline-flex min-h-12 w-full items-center justify-center rounded-pill bg-btn px-5 py-2 text-[15px] font-semibold text-white transition-colors hover:bg-btn-hover disabled:bg-btn/50"
          >
            {busy ? t("on.starting") : t("on.optOrder").replace("{amount}", rupees(basePaise + extra))}
          </button>
        </div>
      </div>
    </div>
  );
}
