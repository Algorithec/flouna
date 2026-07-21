"use client";

import Image from "next/image";
import { usePathname } from "next/navigation";

// Shared frame for the auth screens. Login gets the full-width split layout
// (Figma desktop: Welcome + illustration left, form right) and renders its own
// frame; signup / verify / forgot stay a centered card.
export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();

  if (pathname === "/login") {
    return <div className="min-h-dvh bg-cream">{children}</div>;
  }

  return (
    <div className="flex min-h-dvh flex-1 items-start justify-center bg-cream px-5 py-8 lg:items-center">
      <div className="w-full max-w-md lg:rounded-3xl lg:border lg:border-line lg:bg-cream lg:p-10 lg:shadow-card">
        <div className="flex justify-center">
          <Image
            src="/logo.png"
            alt="Radiues"
            width={56}
            height={56}
            priority
            className="h-14 w-14"
          />
        </div>
        {children}
      </div>
    </div>
  );
}
