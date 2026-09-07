"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { Users, ChevronLeft, Bookmark, ChevronRight } from "lucide-react";
import { api } from "@/lib/api";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import type { GroupCart } from "@/components/food/GroupCartTypes";
import { useBackTo } from "@/lib/navHistory";
import { useI18n } from "@/components/i18n/I18nContext";

export default function GroupStartPage() {
  const { t } = useI18n();
  const router = useRouter();
  const back = useBackTo("/food");
  const search = useSearchParams();
  // Arriving from a shared link (?code=ABC123) — pre-fill so joining is one
  // tap, not a re-type of a code the sender already gave them.
  const [code, setCode] = useState(() =>
    (search.get("code") ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6),
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function create() {
    setBusy(true);
    setError("");
    try {
      // All group orders fulfil in-app — no network choice to make.
      const cart = await api<GroupCart>("/api/groups", {
        method: "POST",
        json: { platform: "ondc" },
      });
      router.push(`/food/group/${cart.id}/invite`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not start group order");
      setBusy(false);
    }
  }

  async function join() {
    setBusy(true);
    setError("");
    try {
      const cart = await api<GroupCart>("/api/groups/join", {
        method: "POST",
        json: { code: code.trim().toUpperCase() },
      });
      // One code space for both kinds — ride codes land on the shared-ride screen.
      router.push(
        cart.domain === "ride" ? `/rides/group/${cart.id}` : `/food/group/${cart.id}`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not join");
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-xl px-4 py-6 lg:max-w-3xl lg:px-6 lg:py-10">
      <button
        type="button"
        onClick={back}
        className="flex items-center gap-1 text-[13px] font-medium text-cocoa hover:text-ink"
      >
        <ChevronLeft size={16} /> {t("nav.food")}
      </button>

      <h1 className="mt-3 flex items-center gap-2 text-[20px] font-bold text-ink">
        <Users size={20} className="text-accent" /> {t("grp.groupOrder")}
      </h1>
      <p className="mt-1 text-[13px] text-cocoa">
        {t("grp.groupOrderSub")}
      </p>

      <Link
        href="/food/crews"
        className="mt-5 flex items-center gap-3 rounded-[18px] bg-card p-3.5 shadow-soft transition-colors hover:bg-beige/30"
      >
        <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-accent-soft">
          <Bookmark size={18} className="text-accent" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[14px] font-bold text-ink">{t("crew.title")}</span>
          <span className="block text-[12px] text-cocoa">{t("crew.entrySub")}</span>
        </span>
        <ChevronRight size={17} className="shrink-0 text-cocoa/60" />
      </Link>

      <div className="lg:mt-2 lg:grid lg:grid-cols-2 lg:gap-4">
      {/* Start new */}
      <Card className="mt-4 lg:mt-0">
        <p className="text-[14px] font-bold text-ink">{t("grp.startNew")}</p>
        <p className="mt-1 text-[12px] text-cocoa">
          {t("grp.startNewSub")}
        </p>
        <Button onClick={create} disabled={busy} className="mt-4 w-full">
          {t("grp.createCode")}
        </Button>
      </Card>

      {/* Join existing */}
      <Card className="mt-4 lg:mt-0">
        <p className="text-[14px] font-bold text-ink">{t("grp.joinWithCode")}</p>
        <div className="mt-3 flex items-end gap-2">
          <Input
            label={t("grp.codeLabel")}
            placeholder="ABC123"
            value={code}
            onChange={(e) =>
              setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6))
            }
          />
          <Button
            size="md"
            variant="secondary"
            onClick={join}
            disabled={busy || code.length !== 6}
          >
            {t("grp.join")}
          </Button>
        </div>
      </Card>

      </div>

      {error && <p className="mt-3 text-[13px] text-danger">{error}</p>}
    </div>
  );
}
