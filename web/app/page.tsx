"use client";

import Link from "next/link";
import { useState } from "react";
import { FadeIn } from "@/components/ui/motion";
import { FlounaLogo } from "@/components/brand/FlounaLogo";
import { GoogleButton } from "@/components/auth/GoogleButton";
import { useI18n } from "@/components/i18n/I18nContext";
import { useAuth } from "@/components/auth/AuthContext";

// Public landing — matches the Figma "intial landing page" frame: the mark
// and headline sit in the upper third, then an open middle, then the three
// entry points anchored to the bottom safe area (Google, Login or Signup,
// Continue without logging in). The static prerender is English (SEO keeps
// indexing English copy); a returning visitor's saved language applies after
// hydration like the rest of the app.
export default function LandingPage() {
  const { t } = useI18n();
  const { user } = useAuth();
  const [googleError, setGoogleError] = useState("");

  return (
    <div className="flex min-h-dvh flex-1 flex-col items-center bg-cream px-6 pb-8 pt-16 [@media(max-height:700px)]:pt-10">
      <div className="flex w-full max-w-sm flex-1 flex-col items-center text-center lg:max-w-2xl">
        <FadeIn y={16}>
          <FlounaLogo
            size={104}
            className="size-[104px] text-ink lg:size-[140px] [@media(max-height:700px)]:size-[76px]"
          />
        </FadeIn>

        <FadeIn delay={0.1} className="mt-6 [@media(max-height:700px)]:mt-4">
          <h1 className="flex flex-col gap-1.5 text-[26px] font-bold leading-[1.2] lg:text-[44px]">
            <span className="text-ink">{t("landing.headline1")}</span>
            <span className="text-accent">{t("landing.headline2")}</span>
          </h1>
        </FadeIn>

        {/* Open middle, same as the Figma frame — nothing competes with the
            mark and headline for attention. */}
        <div className="flex-1" />

        <FadeIn delay={0.25} className="w-full max-w-[340px] lg:max-w-[400px]">
          {/* Someone already signed in is offered the way in, not sign-in
              options that would only send them round again. */}
          {user ? (
            <Link
              href="/home"
              className="flex h-14 w-full items-center justify-center rounded-pill bg-accent text-[16px] font-semibold text-white shadow-soft transition-opacity hover:opacity-90"
            >
              {t("landing.continueAs").replace("{name}", user.name.split(" ")[0] || user.name)}
            </Link>
          ) : (
            <div className="flex flex-col gap-3">
              <GoogleButton onError={setGoogleError} label="Continue with Google" variant="surface" />
              <Link
                href="/login"
                className="flex h-14 w-full items-center justify-center rounded-pill border border-line bg-card text-[16px] font-semibold text-ink shadow-soft transition-colors hover:bg-beige/40"
              >
                {t("landing.loginOrSignup")}
              </Link>
            </div>
          )}
          {googleError && (
            <p role="alert" className="mt-3 text-[13px] text-danger">
              {googleError}
            </p>
          )}
          {!user && (
            <Link
              href="/home"
              className="tap-target mt-5 block text-center text-[14px] font-medium text-cocoa hover:text-ink"
            >
              {t("landing.continueGuest")}
            </Link>
          )}
        </FadeIn>

        <FadeIn delay={0.4} className="mt-6 flex items-center gap-4 text-[12px] text-muted">
          <Link href="/legal/privacy" className="tap-target hover:text-cocoa">
            {t("landing.privacy")}
          </Link>
          <span className="text-line">·</span>
          <Link href="/legal/terms" className="tap-target hover:text-cocoa">
            {t("landing.terms")}
          </Link>
        </FadeIn>
      </div>
    </div>
  );
}
