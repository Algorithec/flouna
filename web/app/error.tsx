"use client";

import { useEffect } from "react";
import Link from "next/link";
import { RotateCcw, Home, TriangleAlert } from "lucide-react";

// App-wide error boundary. Any uncaught render/data error in a route lands here
// instead of a blank page or raw stack trace. Keeps users in the product with a
// clear recover action.
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // In production this is where Sentry/logging would capture the error.
    console.error("[app error]", error);
  }, [error]);

  return (
    <div className="flex min-h-dvh flex-1 flex-col items-center justify-center bg-cream px-6 text-center">
      <div className="flex w-full max-w-sm flex-col items-center">
        <span className="flex size-16 items-center justify-center rounded-[20px] bg-accent-soft">
          <TriangleAlert size={30} className="text-accent" />
        </span>
        <h1 className="mt-6 text-[24px] font-bold tracking-tight text-ink">
          Something went wrong
        </h1>
        <p className="mt-2 text-[14px] leading-relaxed text-cocoa">
          We hit a snag loading this screen. It&apos;s not you, try again, and
          you&apos;ll be back to deciding in a moment.
        </p>

        <div className="mt-8 flex w-full flex-col gap-3">
          <button
            onClick={reset}
            className="group flex h-13 items-center justify-center gap-2 rounded-pill bg-ink-fill text-[15px] font-semibold text-white shadow-lift transition-all hover:gap-3 hover:bg-ink-fill-hover"
          >
            <RotateCcw size={17} className="transition-transform group-hover:-rotate-45" />
            Try again
          </button>
          <Link
            href="/home"
            className="flex h-13 items-center justify-center gap-2 rounded-pill border border-line bg-card text-[15px] font-semibold text-ink transition-colors hover:bg-beige/40"
          >
            <Home size={16} /> Go to home
          </Link>
        </div>

        {error.digest && (
          <p className="mt-6 font-mono text-[11px] text-muted">
            Reference: {error.digest}
          </p>
        )}
      </div>
    </div>
  );
}
