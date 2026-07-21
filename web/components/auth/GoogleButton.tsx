"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { useAuth, type User } from "./AuthContext";

const GOOGLE_CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;

declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize: (config: {
            client_id: string;
            callback: (response: { credential: string }) => void;
          }) => void;
          renderButton: (el: HTMLElement, options: Record<string, unknown>) => void;
        };
      };
    };
  }
}

export function GoogleButton({ onError }: { onError: (msg: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  const router = useRouter();
  const { setUser } = useAuth();

  useEffect(() => {
    if (!GOOGLE_CLIENT_ID || !ref.current) return;

    const init = () => {
      if (!window.google || !ref.current) return;
      window.google.accounts.id.initialize({
        client_id: GOOGLE_CLIENT_ID,
        callback: async ({ credential }) => {
          try {
            const d = await api<{ user: User }>("/api/auth/google", {
              method: "POST",
              json: { credential },
            });
            setUser(d.user);
            router.push("/home");
          } catch (e) {
            onError(e instanceof Error ? e.message : "Google sign-in failed");
          }
        },
      });
      // Size to the actual slot — a fixed width overflows the half-width grid
      // cell on small screens.
      const slot = ref.current.parentElement?.clientWidth ?? 320;
      window.google.accounts.id.renderButton(ref.current, {
        theme: "outline",
        size: "large",
        shape: "pill",
        width: Math.max(120, Math.min(320, slot)),
      });
      setReady(true);
    };

    if (window.google) {
      init();
      return;
    }
    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.onload = init;
    document.head.appendChild(script);
  }, [router, setUser, onError]);

  if (!GOOGLE_CLIENT_ID) {
    return (
      <button
        type="button"
        onClick={() => onError("Google sign-in is not configured yet")}
        className="flex h-12 w-full items-center justify-center gap-2 rounded-pill border border-line bg-card text-[14px] font-semibold text-ink hover:bg-beige/40 transition-colors"
      >
        <span className="font-bold text-accent">G</span> Google
      </button>
    );
  }

  return (
    <div className="flex w-full justify-center overflow-hidden">
      <div ref={ref} className={ready ? "" : "h-12"} />
    </div>
  );
}
