"use client";

import { useEffect, useState } from "react";
import { Wallet, Bell, Languages, Moon, Sun } from "lucide-react";
import { api } from "@/lib/api";
import { SubPage } from "@/components/profile/SubPage";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import {
  disablePush,
  enablePush,
  getSubscriptionState,
} from "@/lib/push";
import { useI18n } from "@/components/i18n/I18nContext";
import { LANGUAGES } from "@/lib/i18n/dictionaries";
import { cn } from "@/lib/cn";
import { useTheme } from "@/components/theme/ThemeContext";

// Server-persisted preferences (PUT /api/users/preferences). Security mail
// (password changed, new address, etc.) isn't listed here — it always sends
// and isn't a user choice.
const PREF_SETTINGS = [
  {
    key: "emailUpdates" as const,
    label: "Order emails",
    subtitle: "Receipts, cancellations, refund updates",
  },
  {
    key: "emailMoneyUpdates" as const,
    label: "Money-saving emails",
    subtitle: "Savings milestones, price drops, Plus value",
  },
  {
    key: "emailTips" as const,
    label: "Tips & announcements",
    subtitle: "New features and occasional offers",
  },
  {
    key: "smartSuggestions" as const,
    label: "Smart suggestions",
    subtitle: "AI picks based on your orders",
  },
];

type Prefs = {
  emailUpdates: boolean;
  smartSuggestions: boolean;
  emailMoneyUpdates: boolean;
  emailTips: boolean;
};

export default function SettingsPage() {
  const { theme, toggle } = useTheme();
  const { t, lang, setLang } = useI18n();
  const [prefs, setPrefs] = useState<Prefs>({
    emailUpdates: true,
    smartSuggestions: true,
    emailMoneyUpdates: true,
    emailTips: true,
  });
  const [pushState, setPushState] = useState<
    "loading" | "unsupported" | "denied" | "subscribed" | "default"
  >("loading");
  const [pushBusy, setPushBusy] = useState(false);
  const [budgetInput, setBudgetInput] = useState("");
  const [budgetSaved, setBudgetSaved] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<{ budgetPaise: number | null }>("/api/users/budget")
      .then((d) => {
        if (d.budgetPaise !== null) setBudgetInput(String(d.budgetPaise / 100));
      })
      .catch(() => {});
    getSubscriptionState()
      .then(setPushState)
      .catch(() => setPushState("unsupported"));
    api<Prefs>("/api/users/preferences").then(setPrefs).catch(() => {});
  }, []);

  function togglePref(key: keyof Prefs) {
    // Optimistic flip; revert if the save fails.
    const previous = prefs;
    const next = { ...prefs, [key]: !prefs[key] };
    setPrefs(next);
    api<Prefs>("/api/users/preferences", {
      method: "PUT",
      json: { [key]: next[key] },
    })
      .then(setPrefs)
      .catch(() => setPrefs(previous));
  }

  async function togglePush() {
    setPushBusy(true);
    try {
      if (pushState === "subscribed") {
        await disablePush();
        setPushState("default");
      } else {
        const result = await enablePush();
        setPushState(result === "subscribed" ? "subscribed" : result === "denied" ? "denied" : pushState);
      }
    } finally {
      setPushBusy(false);
    }
  }

  async function saveBudget(clear: boolean) {
    setBusy(true);
    setBudgetSaved("");
    try {
      const value = clear ? null : Number(budgetInput);
      if (!clear && (!Number.isInteger(value) || value! < 100)) {
        setBudgetSaved("Enter at least ₹100");
        return;
      }
      await api("/api/users/budget", {
        method: "PUT",
        json: { weeklyBudgetRupees: value },
      });
      if (clear) setBudgetInput("");
      setBudgetSaved(clear ? "Budget cleared" : "Budget saved");
    } catch (e) {
      setBudgetSaved(e instanceof Error ? e.message : "Could not save");
    } finally {
      setBusy(false);
    }
  }

  return (
    <SubPage title={t("profile.settings")}>
      {/* Language */}
      <Card className="mb-4">
        <p className="flex items-center gap-1.5 text-[14px] font-bold text-ink">
          <Languages size={15} className="text-accent" /> {t("settings.language")}
        </p>
        <p className="mt-1 text-[12px] text-cocoa">{t("settings.languageSub")}</p>
        {/* Six languages don't fit one row on a phone without either
            squeezing every label or cutting the last one off entirely —
            wrapping instead of forcing flex-1 lets each pill size to its
            own label and overflow onto a second row cleanly. */}
        <div className="mt-3 flex flex-wrap gap-2">
          {LANGUAGES.map((l) => (
            <button
              key={l.code}
              onClick={() => setLang(l.code)}
              className={
                l.code === lang
                  ? "tap-target rounded-pill border border-accent bg-accent-soft px-3.5 py-2 text-[13px] font-semibold text-accent"
                  : "tap-target rounded-pill border border-line bg-card px-3.5 py-2 text-[13px] text-cocoa hover:bg-beige/40"
              }
            >
              {l.label}
            </button>
          ))}
        </div>
      </Card>

      {/* Budget Guardian */}
      <Card className="mb-4">
        <p className="flex items-center gap-1.5 text-[14px] font-bold text-ink">
          <Wallet size={15} className="text-accent" /> {t("settings.budgetTitle")}
        </p>
        <p className="mt-1 text-[12px] text-cocoa">
          Flouna tracks your food spend Monday Sunday and warns you before an
          order takes you over.
        </p>
        <div className="mt-3 flex items-end gap-2">
          <Input
            label="Budget (₹ per week)"
            inputMode="numeric"
            placeholder="e.g. 1500"
            value={budgetInput}
            onChange={(e) => setBudgetInput(e.target.value.replace(/\D/g, "").slice(0, 6))}
          />
          <Button size="md" disabled={busy || !budgetInput} onClick={() => saveBudget(false)}>
            Save
          </Button>
          <Button size="md" variant="secondary" disabled={busy} onClick={() => saveBudget(true)}>
            Clear
          </Button>
        </div>
        {budgetSaved && (
          <p className="mt-2 text-[12px] font-medium text-success">{budgetSaved}</p>
        )}
      </Card>

      {/* Appearance — switches the whole app between the light and dark token
          sets. Stored per device rather than on the account: which theme suits
          you depends on the screen you are holding, not on who you are. */}
      <Card className="mb-4">
        <div className="flex items-center gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-beige/70">
            {theme === "dark" ? (
              <Moon size={16} className="text-accent" />
            ) : (
              <Sun size={16} className="text-accent" />
            )}
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[14px] font-medium text-ink">Dark mode</p>
            <p className="text-[12px] text-cocoa">
              {theme === "dark" ? "On, easier on the eyes at night" : "Off"}
            </p>
          </div>
          <button
            role="switch"
            aria-checked={theme === "dark"}
            aria-label="Dark mode"
            onClick={toggle}
            className={cn(
              "tap-target h-6 w-11 shrink-0 rounded-full p-0.5 transition-colors",
              theme === "dark" ? "bg-accent" : "bg-line",
            )}
          >
            <span
              className={cn(
                "block size-5 rounded-full bg-white shadow transition-transform",
                theme === "dark" && "translate-x-5",
              )}
            />
          </button>
        </div>
      </Card>

      {/* Push notifications — real Web Push subscription */}
      <Card className="mb-4">
        <div className="flex items-center gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-beige/70">
            <Bell size={16} className="text-accent" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[14px] font-medium text-ink">{t("settings.pushTitle")}</p>
            <p className="text-[12px] text-cocoa">
              {pushState === "unsupported"
                ? "Not supported in this browser"
                : pushState === "denied"
                  ? "Blocked, enable in browser settings"
                  : "Order updates and live offers"}
            </p>
          </div>
          <button
            role="switch"
            aria-checked={pushState === "subscribed"}
            aria-label="Push notifications"
            disabled={
              pushBusy || pushState === "unsupported" || pushState === "denied" || pushState === "loading"
            }
            onClick={togglePush}
            className={cn(
              "tap-target h-6 w-11 rounded-full p-0.5 transition-colors disabled:opacity-50",
              pushState === "subscribed" ? "bg-accent" : "bg-line",
            )}
          >
            <span
              className={cn(
                "block size-5 rounded-full bg-white shadow transition-transform",
                pushState === "subscribed" && "translate-x-5",
              )}
            />
          </button>
        </div>
      </Card>

      <p className="mb-2 mt-1 px-1 text-[13px] font-bold text-ink">
        Email &amp; suggestions
      </p>
      <Card className="p-0">
        {PREF_SETTINGS.map((s, i) => (
          <div
            key={s.key}
            className={cn(
              "flex items-center gap-3 px-4 py-3.5",
              i < PREF_SETTINGS.length - 1 && "border-b border-line/70",
            )}
          >
            <div className="min-w-0 flex-1">
              <p className="text-[14px] font-medium text-ink">{s.label}</p>
              <p className="text-[12px] text-cocoa">{s.subtitle}</p>
            </div>
            <button
              role="switch"
              aria-checked={prefs[s.key]}
              aria-label={s.label}
              onClick={() => togglePref(s.key)}
              className={cn(
                "tap-target h-6 w-11 rounded-full p-0.5 transition-colors",
                prefs[s.key] ? "bg-accent" : "bg-line",
              )}
            >
              <span
                className={cn(
                  "block size-5 rounded-full bg-white shadow transition-transform",
                  prefs[s.key] && "translate-x-5",
                )}
              />
            </button>
          </div>
        ))}
      </Card>
    </SubPage>
  );
}
