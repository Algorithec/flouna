"use client";

import { useState } from "react";
import { Download, Printer } from "lucide-react";
import { apiDownload, ApiClientError } from "@/lib/api";

// Export for a console report: a CSV that opens in Excel, built on the server
// from the same figures the page shows, and the browser's print dialog for a
// PDF. Both are left out of the printed page.

const istToday = () => new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);

export function ReportActions({ csvPath, name, className = "" }: { csvPath: string; name: string; className?: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function download() {
    setBusy(true);
    setError("");
    try {
      await apiDownload(csvPath, `flouna-${name}-${istToday()}.csv`);
    } catch (e) {
      setError(e instanceof ApiClientError ? e.message : "Could not export this report.");
    } finally {
      setBusy(false);
    }
  }

  const button =
    "inline-flex items-center gap-1.5 rounded-lg border border-(--c-border) bg-white px-3 py-1.5 text-[13px] font-medium text-(--c-ink) hover:bg-(--c-ivory) disabled:opacity-60";
  return (
    <div className={`flex flex-wrap items-center gap-2 print:hidden ${className}`}>
      <button type="button" onClick={download} disabled={busy} className={button} title="A CSV file, which opens in Excel">
        <Download size={14} aria-hidden /> {busy ? "Exporting" : "Excel"}
      </button>
      <button type="button" onClick={() => window.print()} className={button} title="Opens the print dialog, where Save as PDF is a destination">
        <Printer size={14} aria-hidden /> PDF
      </button>
      {error && (
        <p role="alert" className="w-full text-[12px] text-[#C0392B]">
          {error}
        </p>
      )}
    </div>
  );
}
