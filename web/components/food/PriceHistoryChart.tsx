"use client";

import { useI18n } from "@/components/i18n/I18nContext";
import { useEffect, useState } from "react";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from "recharts";
import { TrendingDown } from "lucide-react";
import { api } from "@/lib/api";
import { rupees } from "@/lib/money";
import { Card } from "@/components/ui/Card";

type Point = { date: string; pricePaise: number };

// Recharts tooltip payload is loosely typed; narrow what we read.
function ChartTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<{ value?: number }>;
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  const paise = payload[0]?.value ?? 0;
  return (
    <div className="rounded-lg border border-line bg-card px-2.5 py-1.5 shadow-card">
      <p className="text-[11px] text-cocoa">{label}</p>
      <p className="text-[13px] font-bold text-ink">{rupees(paise)}</p>
    </div>
  );
}

export function PriceHistoryChart({ dishId }: { dishId: string }) {
  const { t } = useI18n();
  const [points, setPoints] = useState<Point[] | null>(null);

  useEffect(() => {
    api<{ points: Point[] }>(`/api/food/dishes/${dishId}/price-history?days=30`)
      .then((d) => setPoints(d.points))
      .catch(() => setPoints([]));
  }, [dishId]);

  // Need at least 2 points for a meaningful trend line.
  if (!points || points.length < 2) return null;

  const prices = points.map((p) => p.pricePaise);
  const low = Math.min(...prices);
  const high = Math.max(...prices);
  const latest = prices[prices.length - 1]!;
  const trend = latest - prices[0]!;

  const data = points.map((p) => ({
    label: new Date(p.date).toLocaleDateString("en-IN", { day: "numeric", month: "short" }),
    pricePaise: p.pricePaise,
  }));

  return (
    <Card className="mt-5">
      <div className="flex items-center justify-between">
        <p className="flex items-center gap-1.5 text-[13px] font-bold text-ink">
          <TrendingDown size={15} className="text-accent" /> {t("ph.title")}
        </p>
        <p className="text-[12px] text-cocoa">
          {t("ph.range").replace("{low}", rupees(low)).replace("{high}", rupees(high))}
        </p>
      </div>

      <div className="mt-3 h-36 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 5, right: 8, left: -18, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#eee3da" vertical={false} />
            <XAxis
              dataKey="label"
              tick={{ fontSize: 10, fill: "#8b5e3c" }}
              tickLine={false}
              axisLine={false}
              minTickGap={24}
            />
            <YAxis
              tickFormatter={(v: number) => `₹${Math.round(v / 100)}`}
              tick={{ fontSize: 10, fill: "#8b5e3c" }}
              tickLine={false}
              axisLine={false}
              width={44}
              domain={["dataMin - 1000", "dataMax + 1000"]}
            />
            <Tooltip content={<ChartTooltip />} />
            <Line
              type="monotone"
              dataKey="pricePaise"
              stroke="#e8651a"
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4 }}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <p className="mt-1 text-[12px] text-cocoa">
        {trend < 0
          ? t("ph.down").replace("{amount}", rupees(Math.abs(trend)))
          : trend > 0
            ? t("ph.up").replace("{amount}", rupees(trend))
            : t("ph.steady")}
      </p>
    </Card>
  );
}
