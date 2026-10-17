"use client";

import { useI18n } from "@/components/i18n/I18nContext";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { cn } from "@/lib/cn";
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

// Google's script is loaded once per page, however many buttons mount or
// re-render, and set up once: the button that is on screen now receives the
// credential through activeCallback.
let googleScript: Promise<void> | null = null;
function loadGoogle(): Promise<void> {
  if (window.google) return Promise.resolve();
  googleScript ??= new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      googleScript = null;
      reject(new Error("Google sign-in could not load"));
    };
    document.head.appendChild(script);
  });
  return googleScript.catch(() => undefined);
}

let initialized = false;
let activeCallback: (credential: string) => void = () => {};
function initializeOnce(clientId: string, callback: (credential: string) => void) {
  if (initialized || !window.google) return;
  window.google.accounts.id.initialize({ client_id: clientId, callback: ({ credential }) => callback(credential) });
  initialized = true;
}

export function GoogleButton({
  onError,
  label = "Google",
  variant = "auth",
}: {
  onError: (msg: string) => void;
  /** "Google" beside Apple on login; "Continue with Google" full-width on signup. */
  label?: string;
  /** "auth" — the always-white pill the login/signup frames draw, even in
   *  dark mode. "surface" — the theme-aware card tone the public landing
   *  page's other buttons use. */
  variant?: "auth" | "surface";
}) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  const router = useRouter();
  const { setUser } = useAuth();
  const surface =
    variant === "surface"
      ? "border-line bg-card text-ink shadow-soft"
      : "border-auth-line bg-auth-alt text-auth-alt-ink";

  // What a successful Google sign-in does, kept current without setting
  // Google up again: initialize() may only be called once per page, and a
  // later call replaces the earlier callback, so it used to run again on
  // every language change and Google warned that it was "called multiple
  // times".
  const onCredential = useRef<(credential: string) => void>(() => {});
  useEffect(() => {
    onCredential.current = async (credential: string) => {
      try {
        const d = await api<{ user: User }>("/api/auth/google", {
          method: "POST",
          json: { credential },
        });
        setUser(d.user);
        router.replace("/home");
      } catch (e) {
        onError(e instanceof Error ? e.message : t("gb.failed"));
      }
    };
  }, [router, setUser, onError, t]);

  useEffect(() => {
    if (!GOOGLE_CLIENT_ID || !ref.current) return;
    let alive = true;
    void loadGoogle().then(() => {
      if (!alive || !window.google || !ref.current) return;
      initializeOnce(GOOGLE_CLIENT_ID, (credential) => activeCallback(credential));
      activeCallback = (credential) => onCredential.current(credential);
      // Size to the actual slot — a fixed width overflows the half-width grid
      // cell on small screens.
      const slot = ref.current.parentElement?.clientWidth ?? 320;
      window.google.accounts.id.renderButton(ref.current, {
        theme: "outline",
        size: "large",
        shape: "pill",
        // Google's own copy defaults to "Sign in with Google" — "continue_with"
        // is the one variant that reads the same as the rest of the flow.
        text: "continue_with",
        // 400 is Google's own ceiling. Filling the slot up to it keeps this
        // button the same width as the pills stacked with it — below that cap
        // it visibly under-hangs them.
        width: Math.max(120, Math.min(400, slot)),
      });
      setReady(true);
    });
    return () => {
      alive = false;
    };
  }, []);

  if (!GOOGLE_CLIENT_ID) {
    const handleDevLogin = async () => {
      if (process.env.NODE_ENV === "production") {
        onError(t("gb.notConfigured"));
        return;
      }
      try {
        const d = await api<{ user: User }>("/api/auth/google", {
          method: "POST",
          json: { credential: "dev-mock-google" },
        });
        setUser(d.user);
        router.replace("/home");
      } catch (e) {
        onError(e instanceof Error ? e.message : t("gb.failed"));
      }
    };

    return (
      <button
        type="button"
        onClick={handleDevLogin}
        className={cn(
          "flex h-14 w-full items-center justify-center gap-3 rounded-pill border text-[16px] font-semibold transition-colors hover:opacity-90",
          surface,
        )}
      >
        <GoogleG size={20} />
        {label}
      </button>
    );
  }

  return (
    // Google won't let its button be restyled, and its own pill is shorter
    // than ours — so this renders our real pill as the visible layer and
    // lays Google's actual button on top at full size, invisible. The click
    // still lands on Google's own element; only the paint is ours.
    <div className={cn("relative flex h-14 w-full items-center justify-center gap-3 rounded-pill border text-[16px] font-semibold", surface)}>
      <GoogleG size={20} />
      <span aria-hidden>{label}</span>
      <div
        ref={ref}
        className={cn(
          "absolute inset-0 flex items-center justify-center overflow-hidden opacity-0",
          !ready && "invisible",
        )}
      />
    </div>
  );
}

// Google's four-colour mark. Inlined rather than pulled from a CDN so the
// button still renders correctly offline, which is how the demo mode runs.
function GoogleG({ size = 19 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden>
      <path
        fill="#4285F4"
        d="M45.12 24.5c0-1.56-.14-3.06-.4-4.5H24v8.51h11.84c-.51 2.75-2.06 5.08-4.39 6.64v5.52h7.11c4.16-3.83 6.56-9.47 6.56-16.17z"
      />
      <path
        fill="#34A853"
        d="M24 46c5.94 0 10.92-1.97 14.56-5.33l-7.11-5.52c-1.97 1.32-4.49 2.1-7.45 2.1-5.73 0-10.58-3.87-12.31-9.07H4.34v5.7C7.96 41.07 15.4 46 24 46z"
      />
      <path
        fill="#FBBC05"
        d="M11.69 28.18c-.44-1.32-.69-2.73-.69-4.18s.25-2.86.69-4.18v-5.7H4.34C2.85 17.09 2 20.45 2 24s.85 6.91 2.34 9.88l7.35-5.7z"
      />
      <path
        fill="#EA4335"
        d="M24 10.75c3.23 0 6.13 1.11 8.41 3.29l6.31-6.31C34.91 4.18 29.93 2 24 2 15.4 2 7.96 6.93 4.34 14.12l7.35 5.7c1.73-5.2 6.58-9.07 12.31-9.07z"
      />
    </svg>
  );
}
