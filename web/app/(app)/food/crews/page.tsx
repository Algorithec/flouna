"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Users, RotateCcw, Trash2, Repeat, Plus } from "lucide-react";
import { api } from "@/lib/api";
import { Card } from "@/components/ui/Card";
import { GroupHeader } from "@/components/food/GroupHeader";
import type { Crew } from "@/components/food/GroupCartTypes";
import { useI18n } from "@/components/i18n/I18nContext";
import { useToast } from "@/components/ui/Toast";
import { FadeIn, Stagger, StaggerItem } from "@/components/ui/motion";
import { cn } from "@/lib/cn";

// Saved crews.
//
// The second time a group orders, the link, the wait and the four people
// remembering to tap it are all pure overhead. This is that overhead removed:
// the crew is the people, and reopening one seats them straight away.

export default function CrewsPage() {
  const router = useRouter();
  const { t } = useI18n();
  const { toast } = useToast();
  const [crews, setCrews] = useState<Crew[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // Delete was one tap on a small icon beside the crew's name, with nothing in
  // the way and nothing to undo it: the saved group and everyone in it were
  // gone. It asks now.
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const load = useCallback(() => {
    api<{ crews: Crew[] }>("/api/groups/crews")
      .then((d) => setCrews(d.crews))
      .catch(() => setCrews([]));
  }, []);

  useEffect(load, [load]);

  async function reopen(crew: Crew, withUsual: boolean) {
    setBusy(crew.id);
    try {
      const d = await api<{
        cartId: string;
        invited: number;
        excluded: number;
        readded: number;
        unavailable: number;
      }>(`/api/groups/crews/${crew.id}/reopen`, {
        method: "POST",
        json: { withUsual },
      });
      // Say what actually happened rather than letting the cart quietly differ
      // from what the crew promised.
      if (d.unavailable > 0) {
        toast(t("crew.someUnavailable").replace("{n}", String(d.unavailable)));
      } else if (d.excluded > 0) {
        toast(t("crew.someExcluded").replace("{n}", String(d.excluded)));
      }
      router.push(`/food/group/${d.cartId}`);
    } catch (e) {
      toast(e instanceof Error ? e.message : t("crew.reopenFailed"));
      setBusy(null);
    }
  }

  async function remove(crew: Crew) {
    setBusy(crew.id);
    try {
      await api(`/api/groups/crews/${crew.id}`, { method: "DELETE" });
      setConfirmDelete(null);
      setCrews((prev) => (prev ?? []).filter((c) => c.id !== crew.id));
    } catch (e) {
      toast(e instanceof Error ? e.message : t("crew.deleteFailed"));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mx-auto w-full max-w-xl px-4 pb-10 lg:max-w-2xl lg:px-6">
      <GroupHeader title={t("crew.title")} backTo="/food/group" />

      {crews === null ? (
        <p className="py-8 text-center text-[13px] text-cocoa">{t("common.loading")}</p>
      ) : crews.length === 0 ? (
        <FadeIn>
          <Card className="py-10 text-center">
            <span className="mx-auto flex size-14 items-center justify-center rounded-full bg-accent-soft">
              <Users size={24} className="text-accent" />
            </span>
            <p className="mt-3 text-[15px] font-bold text-ink">{t("crew.emptyTitle")}</p>
            <p className="mx-auto mt-1 max-w-[19rem] text-[13px] leading-relaxed text-cocoa">
              {t("crew.emptySub")}
            </p>
            <button
              onClick={() => router.push("/food/group")}
              className="mt-4 inline-flex h-[46px] items-center gap-2 rounded-pill bg-accent px-5 text-[14px] font-bold text-white"
            >
              <Plus size={16} /> {t("crew.startOne")}
            </button>
          </Card>
        </FadeIn>
      ) : (
        <Stagger className="flex flex-col gap-3">
          {crews.map((crew) => (
            <StaggerItem key={crew.id}>
              <Card className="py-3.5">
                <div className="flex items-center gap-3">
                  <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-accent-soft text-[20px]">
                    {crew.emoji ?? <Users size={19} className="text-accent" />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[16px] font-extrabold text-ink">{crew.name}</p>
                    <p className="mt-0.5 truncate text-[12px] text-cocoa">
                      {crew.members
                        .map((m) => (m.isYou ? t("crew.you") : m.name))
                        .join(", ")}
                    </p>
                  </div>
                  <button
                    onClick={() => setConfirmDelete(crew.id)}
                    disabled={busy === crew.id}
                    aria-label={t("crew.delete").replace("{name}", crew.name)}
                    className="tap-target flex size-9 shrink-0 items-center justify-center rounded-full text-cocoa transition-colors hover:bg-danger-soft hover:text-danger disabled:opacity-50"
                  >
                    <Trash2 size={16} />
                  </button>
                </div>

                {confirmDelete === crew.id && (
                  <div className="mt-3 rounded-[14px] bg-danger-soft px-3.5 py-3">
                    <p className="text-[13px] text-ink">{t("crew.deleteAsk")}</p>
                    <div className="mt-2.5 flex gap-2">
                      <button
                        onClick={() => setConfirmDelete(null)}
                        className="tap-target flex-1 rounded-pill border border-line bg-card py-2 text-[13px] font-semibold text-ink"
                      >
                        {t("common.cancel")}
                      </button>
                      <button
                        onClick={() => remove(crew)}
                        disabled={busy === crew.id}
                        className="tap-target flex-1 rounded-pill bg-danger py-2 text-[13px] font-bold text-white disabled:opacity-60"
                      >
                        {t("crew.deleteYes")}
                      </button>
                    </div>
                  </div>
                )}

                <div className="mt-3 flex flex-col gap-2 border-t border-line pt-3 sm:flex-row">
                  <button
                    onClick={() => reopen(crew, false)}
                    disabled={busy === crew.id || crew.domain !== "food"}
                    className={cn(
                      "tap-target flex h-[46px] flex-1 items-center justify-center gap-2 rounded-pill border border-line bg-card text-[14px] font-semibold text-ink transition-colors hover:bg-beige/40",
                      "disabled:opacity-45",
                    )}
                  >
                    <RotateCcw size={15} /> {t("crew.openAgain")}
                  </button>
                  <button
                    onClick={() => reopen(crew, true)}
                    disabled={busy === crew.id || crew.domain !== "food" || !crew.lastCartId}
                    className="tap-target flex h-[46px] flex-1 items-center justify-center gap-2 rounded-pill bg-accent text-[14px] font-bold text-white transition-opacity hover:opacity-90 disabled:opacity-45"
                  >
                    <Repeat size={15} /> {t("crew.orderTheUsual")}
                  </button>
                </div>

                {crew.domain !== "food" && (
                  // A shared ride is a specific trip at a specific time; there
                  // is nothing honest to reopen, and the people are still worth
                  // keeping.
                  <p className="mt-2 text-[11px] text-cocoa">{t("crew.rideCannotReopen")}</p>
                )}
              </Card>
            </StaggerItem>
          ))}
        </Stagger>
      )}
    </div>
  );
}
