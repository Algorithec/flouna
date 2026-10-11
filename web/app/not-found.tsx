import Link from "next/link";
import { Home, MessageSquareText } from "lucide-react";
import { FlounaLogo } from "@/components/brand/FlounaLogo";

// Branded 404 — shown for any unknown route.
export default function NotFound() {
  return (
    <div className="flex min-h-dvh flex-1 flex-col items-center justify-center bg-cream px-6 text-center">
      <div className="flex w-full max-w-sm flex-col items-center">
        <FlounaLogo size={64} className="text-ink" />
        <p className="mt-6 text-[52px] font-bold leading-none tracking-tight text-accent">
          404
        </p>
        <h1 className="mt-3 text-[22px] font-bold tracking-tight text-ink">
          This page took a wrong turn
        </h1>
        <p className="mt-2 text-[14px] leading-relaxed text-cocoa">
          The page you&apos;re looking for doesn&apos;t exist or has moved.
          Let&apos;s get you back on track.
        </p>

        <div className="mt-8 flex w-full flex-col gap-3">
          <Link
            href="/home"
            className="flex h-13 items-center justify-center gap-2 rounded-pill bg-ink-fill text-[15px] font-semibold text-white shadow-lift transition-colors hover:bg-ink-fill-hover"
          >
            <Home size={16} /> Back to home
          </Link>
          <Link
            href="/home"
            className="flex h-13 items-center justify-center gap-2 rounded-pill border border-line bg-card text-[15px] font-semibold text-ink transition-colors hover:bg-beige/40"
          >
            <MessageSquareText size={16} className="text-accent" /> Ask Flouna
          </Link>
        </div>
      </div>
    </div>
  );
}
