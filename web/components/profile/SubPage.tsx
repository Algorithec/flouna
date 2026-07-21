"use client";

import Link from "next/link";
import { ChevronLeft } from "lucide-react";

export function SubPage({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mx-auto w-full max-w-xl px-4 py-5 lg:max-w-[780px] lg:px-6 lg:py-10">
      <div className="relative flex items-center justify-center py-2">
        <Link
          href="/profile"
          aria-label="Back to profile"
          className="absolute left-0 rounded-full p-2 text-ink hover:bg-beige"
        >
          <ChevronLeft size={20} />
        </Link>
        <h1 className="text-[17px] font-bold text-ink lg:text-[24px]">{title}</h1>
      </div>
      <div className="mt-4">{children}</div>
    </div>
  );
}
