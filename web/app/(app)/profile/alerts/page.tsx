"use client";

import { useCallback, useEffect, useState } from "react";
import { Bell, BellOff, Trash2, TrendingDown } from "lucide-react";
import { api } from "@/lib/api";
import { rupees } from "@/lib/money";
import { useI18n } from "@/components/i18n/I18nContext";
import { SubPage } from "@/components/profile/SubPage";
import { Card } from "@/components/ui/Card";
import { EmptyView } from "@/components/ui/StatusView";
import { ListSkeleton } from "@/components/ui/Skeleton";

type Alert = {
  id: string;
  itemName: string;
  domain: string;
  targetPaise: number;
  lastSeenPaise: number;
  active: boolean;
  triggeredAt: string | null;
};

export default function AlertsPage() {
  const { t } = useI18n();
  // null = not loaded yet, so the empty state can't flash before data.
  const [alerts, setAlerts] = useState<Alert[] | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(
    () =>
      api<{ alerts: Alert[] }>("/api/alerts")
        .then((d) => setAlerts(d.alerts))
        .catch((e) => setError(e instanceof Error ? e.message : t("od.loadFailed"))),
    [t],
  );

  useEffect(() => {
    load();
  }, [load]);

  async function remove(id: string) {
    await api(`/api/alerts/${id}`, { method: "DELETE" }).catch(() => {});
    await load();
  }

  const active = (alerts ?? []).filter((a) => a.active);
  const past = (alerts ?? []).filter((a) => !a.active);

  return (
    <SubPage title={t("profile.alerts")}>
      {error && <p className="text-[13px] text-danger">{error}</p>}

      {alerts === null && !error && <ListSkeleton rows={3} />}

      {alerts !== null && alerts.length === 0 && !error && (
        <EmptyView
          icon={BellOff}
          title={t("pp.alerts.empty")}
          message="Set a target price on any dish and we'll tell you the moment it drops."
          actionLabel="Browse food"
          actionHref="/food"
        />
      )}

      {active.length > 0 && (
        <>
          <h2 className="text-[13px] font-bold text-ink">{t("pp.alerts.watching")}</h2>
          <div className="mt-2 flex flex-col gap-2">
            {active.map((a) => (
              <Card key={a.id} className="py-3">
                <div className="flex items-center gap-3">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-beige/70">
                    <Bell size={16} className="text-accent" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[14px] font-semibold text-ink">
                      {a.itemName}
                    </p>
                    <p className="text-[12px] text-cocoa">
                      {t("pp.alerts.notifyBelow")} {rupees(a.targetPaise)} · {t("pp.alerts.lastSeen")}{" "}
                      {rupees(a.lastSeenPaise)}
                    </p>
                  </div>
                  <button
                    onClick={() => remove(a.id)}
                    aria-label={t("pp.alerts.remove")}
                    className="rounded-full p-1.5 text-cocoa/60 hover:bg-danger/10 hover:text-danger"
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              </Card>
            ))}
          </div>
        </>
      )}

      {past.length > 0 && (
        <>
          <h2 className="mt-5 text-[13px] font-bold text-ink">{t("pp.alerts.triggered")}</h2>
          <div className="mt-2 flex flex-col gap-2">
            {past.map((a) => (
              <Card key={a.id} className="py-3 opacity-80">
                <div className="flex items-center gap-3">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-success-soft">
                    <TrendingDown size={16} className="text-success" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[14px] font-semibold text-ink">
                      {a.itemName}
                    </p>
                    <p className="text-[12px] text-success">
                      {t("al.hit")
                        .replace("{price}", rupees(a.lastSeenPaise))
                        .replace("{target}", rupees(a.targetPaise))}
                    </p>
                  </div>
                  <button
                    onClick={() => remove(a.id)}
                    aria-label={t("pp.alerts.remove")}
                    className="rounded-full p-1.5 text-cocoa/60 hover:bg-danger/10 hover:text-danger"
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              </Card>
            ))}
          </div>
        </>
      )}
    </SubPage>
  );
}
