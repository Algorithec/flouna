"use client";

import { useI18n } from "@/components/i18n/I18nContext";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { CheckCircle2, Info, TriangleAlert, X } from "lucide-react";
import { cn } from "@/lib/cn";

// Lightweight app-wide toast. One consistent way to confirm an action ("Added
// to cart", "Rating saved") or surface a soft error, instead of every screen
// inventing its own inline feedback. Themed with the Flouna tokens.

type ToastKind = "success" | "error" | "info";
type Toast = { id: number; kind: ToastKind; message: string };

type ToastCtx = {
  toast: (message: string, kind?: ToastKind) => void;
};

const Ctx = createContext<ToastCtx | null>(null);

const AUTO_DISMISS_MS = 2600;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts((list) => list.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback((message: string, kind: ToastKind = "success") => {
    const id = nextId.current++;
    setToasts((list) => [...list.slice(-2), { id, kind, message }]); // keep at most 3
  }, []);

  const value = useMemo(() => ({ toast }), [toast]);

  return (
    <Ctx.Provider value={value}>
      {children}
      {/* Above the mobile bottom nav; centred on desktop. */}
      <div className="pointer-events-none fixed inset-x-0 bottom-20 z-[60] flex flex-col items-center gap-2 px-4 lg:bottom-6">
        {toasts.map((t) => (
          <ToastRow key={t.id} toast={t} onDismiss={() => dismiss(t.id)} />
        ))}
      </div>
    </Ctx.Provider>
  );
}

const ICONS = {
  success: CheckCircle2,
  error: TriangleAlert,
  info: Info,
} as const;

const TONE = {
  success: "border-success/40 text-success",
  error: "border-danger/40 text-danger",
  info: "border-accent/40 text-accent",
} as const;

function ToastRow({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  const { t } = useI18n();
  const Icon = ICONS[toast.kind];
  useEffect(() => {
    const t = setTimeout(onDismiss, AUTO_DISMISS_MS);
    return () => clearTimeout(t);
  }, [onDismiss]);

  return (
    <div
      role="status"
      className={cn(
        "pointer-events-auto flex w-full max-w-sm animate-[toastIn_0.22s_ease] items-center gap-2.5 rounded-pill border bg-card px-4 py-2.5 shadow-lift",
        TONE[toast.kind],
      )}
    >
      <Icon size={17} className="shrink-0" />
      <span className="min-w-0 flex-1 text-[13px] font-medium text-ink">
        {toast.message}
      </span>
      <button
        onClick={onDismiss}
        aria-label={t("common.dismiss")}
        className="shrink-0 rounded-full p-0.5 text-cocoa/50 hover:text-cocoa"
      >
        <X size={14} />
      </button>
    </div>
  );
}

// Safe to call anywhere under the provider; a no-op if somehow used outside it
// (so a component can't crash on feedback).
export function useToast(): ToastCtx {
  return useContext(Ctx) ?? { toast: () => {} };
}
