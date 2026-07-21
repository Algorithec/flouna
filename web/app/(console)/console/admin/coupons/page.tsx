"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { StatCard } from "@/components/console/ConsoleShell";
import { ConsolePage, Card, Table, Badge, Empty, rupees } from "@/components/console/ui";

type Coupon = { code: string; domain: string; timesApplied: number; savedPaise: number };

export default function CouponsPage() {
  const [coupons, setCoupons] = useState<Coupon[]>([]);
  const [meta, setMeta] = useState({ active: 0, saved: 0 });

  useEffect(() => {
    api<{ activeCoupons: number; totalSavedPaise: number; coupons: Coupon[] }>(
      "/api/console/admin/coupons",
    )
      .then((d) => {
        setCoupons(d.coupons);
        setMeta({ active: d.activeCoupons, saved: d.totalSavedPaise });
      })
      .catch(() => {});
  }, []);

  return (
    <ConsolePage accept={["admin", "super_admin"]}>
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-(--c-ink)">Coupon engine</h1>
        <p className="mt-1 text-[13px] text-(--c-muted)">
          Offers the AI applied on real orders, and the savings each generated.
        </p>
      </div>

      <div className="mb-4 grid grid-cols-2 gap-3">
        <StatCard label="Distinct offers applied" value={meta.active} />
        <StatCard label="Total value saved" value={rupees(meta.saved)} tone="good" />
      </div>

      <Card title="Applied coupons">
        {coupons.length === 0 ? (
          <Empty>No coupons applied yet.</Empty>
        ) : (
          <Table head={["Code / label", "Domain", "Times applied", "Savings generated"]}>
            {coupons.map((c) => (
              <tr key={c.code} className="hover:bg-[#f7f1e6]">
                <td className="px-4 py-2.5 font-medium text-(--c-ink)">{c.code}</td>
                <td className="px-4 py-2.5">
                  <Badge tone={c.domain === "food" ? "amber" : "blue"}>{c.domain}</Badge>
                </td>
                <td className="px-4 py-2.5 text-(--c-ink)">{c.timesApplied}</td>
                <td className="px-4 py-2.5 text-[#1a7a4a]">{rupees(c.savedPaise)}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </ConsolePage>
  );
}
