"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { StatCard } from "@/components/console/ConsoleShell";
import { ConsolePage, Card, Table, Badge, Empty, rupees } from "@/components/console/ui";

type Vendor = {
  name: string;
  domain: string;
  source: string;
  orders: number;
  gmvPaise: number;
  commissionPaise: number;
};

export default function VendorsPage() {
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [meta, setMeta] = useState({ total: 0, ondc: 0 });

  useEffect(() => {
    api<{ totalVendors: number; ondcVendors: number; vendors: Vendor[] }>(
      "/api/console/admin/vendors",
    )
      .then((d) => {
        setVendors(d.vendors);
        setMeta({ total: d.totalVendors, ondc: d.ondcVendors });
      })
      .catch(() => {});
  }, []);

  return (
    <ConsolePage accept={["admin", "super_admin"]}>
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-(--c-ink)">Vendors / MSMEs</h1>
        <p className="mt-1 text-[13px] text-(--c-muted)">
          Derived from real paid orders — vendors actually transacting through Radiues.
        </p>
      </div>

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-3">
        <StatCard label="Active vendors" value={meta.total} />
        <StatCard label="ONDC vendors" value={meta.ondc} tone="good" />
        <StatCard label="Partner vendors" value={meta.total - meta.ondc} />
      </div>

      <Card title="Vendor performance">
        {vendors.length === 0 ? (
          <Empty>No vendor activity yet — paid orders populate this.</Empty>
        ) : (
          <Table head={["Vendor", "Domain", "Source", "Orders", "GMV", "Commission to Radiues"]}>
            {vendors.map((v) => (
              <tr key={v.name} className="hover:bg-[#f7f1e6]">
                <td className="px-4 py-2.5 font-medium text-(--c-ink)">{v.name}</td>
                <td className="px-4 py-2.5 capitalize text-(--c-muted)">{v.domain}</td>
                <td className="px-4 py-2.5">
                  <Badge tone={v.source === "ONDC" ? "green" : "slate"}>{v.source}</Badge>
                </td>
                <td className="px-4 py-2.5 text-(--c-ink)">{v.orders}</td>
                <td className="px-4 py-2.5 text-(--c-ink)">{rupees(v.gmvPaise)}</td>
                <td className="px-4 py-2.5 text-[#1a7a4a]">{rupees(v.commissionPaise)}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </ConsolePage>
  );
}
