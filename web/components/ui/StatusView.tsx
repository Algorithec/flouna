import Link from "next/link";
import { useI18n } from "@/components/i18n/I18nContext";
import { Loader2, TriangleAlert, SearchX } from "lucide-react";
import { CardSkeleton } from "@/components/ui/Skeleton";

// A small, consistent screen-state view: loading, error, or empty/not-found.
// Replaces ad-hoc `{error || "Loading…"}` patterns that can get stuck showing
// "Loading…" forever when a request actually failed.

export function LoadingView({ rows = 4 }: { rows?: number }) {
  const { t } = useI18n();
  return (
    <div className="mx-auto w-full max-w-xl px-4 py-8 lg:px-6">
      <div className="flex items-center gap-2 text-[13px] text-cocoa">
        <Loader2 size={15} className="animate-spin text-accent" /> {t("dp.loading")}
      </div>
      <div className="mt-5 flex flex-col gap-2.5">
        {Array.from({ length: rows }).map((_, i) => (
          <CardSkeleton key={i} />
        ))}
      </div>
    </div>
  );
}

export function ErrorView({
  title,
  message,
  backHref = "/home",
  backLabel,
  notFound = false,
}: {
  title?: string;
  message?: string;
  backHref?: string;
  backLabel?: string;
  notFound?: boolean;
}) {
  const { t } = useI18n();
  const Icon = notFound ? SearchX : TriangleAlert;
  // Defaults worded here, where the language is known.
  title ??= t("common.somethingWrong");
  backLabel ??= t("sv.home");
  return (
    <div className="mx-auto flex min-h-[60dvh] w-full max-w-xl flex-col items-center justify-center px-6 text-center">
      <span className="flex size-14 items-center justify-center rounded-[18px] bg-accent-soft">
        <Icon size={26} className="text-accent" />
      </span>
      <h1 className="mt-5 text-[18px] font-bold text-ink">{title}</h1>
      {message && (
        <p className="mt-1.5 max-w-[300px] text-[13px] leading-relaxed text-cocoa">
          {message}
        </p>
      )}
      <Link
        href={backHref}
        className="mt-6 rounded-pill bg-ink px-6 py-2.5 text-[14px] font-semibold text-white transition-colors hover:bg-[#2c1500]"
      >
        {backLabel}
      </Link>
    </div>
  );
}

// Empty state for a list that loaded fine but has nothing in it. Distinct from
// ErrorView (something broke) and from the loading state — a list initialised
// to [] must not render this until the fetch has actually resolved, or the
// message flashes before the data arrives.
export function EmptyView({
  icon: Icon,
  title,
  message,
  actionLabel,
  actionHref,
}: {
  icon: React.ComponentType<{ size?: number; className?: string }>;
  title: string;
  message?: string;
  actionLabel?: string;
  actionHref?: string;
}) {
  return (
    <div className="flex flex-col items-center px-6 py-12 text-center">
      <span className="flex size-14 items-center justify-center rounded-[18px] bg-beige/70">
        <Icon size={24} className="text-cocoa" />
      </span>
      <p className="mt-3 text-[14px] font-semibold text-ink">{title}</p>
      {message && (
        <p className="mt-1 max-w-xs text-[12px] leading-relaxed text-cocoa">{message}</p>
      )}
      {actionLabel && actionHref && (
        <Link
          href={actionHref}
          className="mt-5 rounded-pill bg-accent px-5 py-2.5 text-[13px] font-semibold text-white transition-colors hover:bg-[#d4570f]"
        >
          {actionLabel}
        </Link>
      )}
    </div>
  );
}
