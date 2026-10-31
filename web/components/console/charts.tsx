"use client";

import {
  PieChart,
  Pie,
  Cell,
  BarChart,
  Bar,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";

// Chart primitives themed to the founder's maroon/gold brand. Series colours are
// drawn from the palette so every chart reads as part of the same system.
export const SERIES = ["#7B0C1B", "#C0392B", "#E8A020", "#B8860B", "#5C0710", "#A0522D"];

const AXIS = "#8A8178";
const GRID = "#E6DCCB";

const tooltipStyle = {
  background: "#fff",
  border: "1px solid #E6DCCB",
  borderRadius: 10,
  fontSize: 12,
  color: "#2C2C2C",
} as const;

// Donut / pie — e.g. revenue split, domain breakdown.
export function DonutChart({
  data,
  height = 240,
}: {
  data: { name: string; value: number }[];
  height?: number;
}) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <PieChart>
        <Pie
          data={data}
          dataKey="value"
          nameKey="name"
          innerRadius="55%"
          outerRadius="82%"
          paddingAngle={2}
          stroke="#fff"
          strokeWidth={2}
        >
          {data.map((_, i) => (
            <Cell key={i} fill={SERIES[i % SERIES.length]} />
          ))}
        </Pie>
        <Tooltip contentStyle={tooltipStyle} />
        <Legend
          verticalAlign="bottom"
          iconType="circle"
          wrapperStyle={{ fontSize: 12, color: "#2C2C2C" }}
        />
      </PieChart>
    </ResponsiveContainer>
  );
}

// Vertical bars — e.g. GMV by domain, orders by status. Uses a maroon fill by
// default; pass `colorful` to colour each bar from the series palette.
export function BarChartC({
  data,
  height = 260,
  colorful = false,
  valueLabel,
}: {
  data: { name: string; value: number }[];
  height?: number;
  colorful?: boolean;
  valueLabel?: (v: number) => string;
}) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 4 }}>
        <XAxis dataKey="name" tick={{ fontSize: 11, fill: AXIS }} axisLine={{ stroke: GRID }} tickLine={false} />
        <YAxis
          tick={{ fontSize: 11, fill: AXIS }}
          axisLine={{ stroke: GRID }}
          tickLine={false}
          tickFormatter={valueLabel}
          width={valueLabel ? 56 : 40}
        />
        <Tooltip
          contentStyle={tooltipStyle}
          cursor={{ fill: "rgba(123,12,27,0.06)" }}
          formatter={(v) => (valueLabel ? valueLabel(Number(v)) : String(v))}
        />
        <Bar dataKey="value" radius={[5, 5, 0, 0]} maxBarSize={44}>
          {data.map((_, i) => (
            <Cell key={i} fill={colorful ? SERIES[i % SERIES.length] : "#7B0C1B"} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

// Trend line — e.g. revenue/orders over time.
export function LineChartC({
  data,
  height = 240,
  valueLabel,
}: {
  // A null value is a gap in the line, for a day with nothing to measure.
  data: { name: string; value: number | null }[];
  height?: number;
  valueLabel?: (v: number) => string;
}) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 4 }}>
        <XAxis dataKey="name" tick={{ fontSize: 11, fill: AXIS }} axisLine={{ stroke: GRID }} tickLine={false} />
        <YAxis
          tick={{ fontSize: 11, fill: AXIS }}
          axisLine={{ stroke: GRID }}
          tickLine={false}
          tickFormatter={valueLabel}
          width={valueLabel ? 56 : 40}
        />
        <Tooltip contentStyle={tooltipStyle} formatter={(v) => (valueLabel ? valueLabel(Number(v)) : String(v))} />
        <Line
          type="monotone"
          dataKey="value"
          stroke="#C0392B"
          strokeWidth={2.5}
          dot={{ r: 3, fill: "#7B0C1B" }}
          activeDot={{ r: 5 }}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
