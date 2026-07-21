"use client";

import { useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { Phone, Mail, Lock, Eye, EyeOff, Apple } from "lucide-react";
import { api, ApiClientError } from "@/lib/api";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { GoogleButton } from "@/components/auth/GoogleButton";
import { useAuth, type User } from "@/components/auth/AuthContext";

export default function LoginPage() {
  const router = useRouter();
  const { setUser } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [busy, setBusy] = useState(false);
  const [showPw, setShowPw] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const d = await api<{ user: User }>("/api/auth/login", {
        method: "POST",
        json: { email, password },
      });
      setUser(d.user);
      router.push("/home");
    } catch (err) {
      if (err instanceof ApiClientError && err.status === 403) {
        // Account exists but email unverified — backend has re-sent a code.
        sessionStorage.setItem("pendingEmail", email);
        router.push("/verify");
        return;
      }
      setError(err instanceof Error ? err.message : "Sign in failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-md flex-col px-5 py-8 lg:max-w-none lg:flex-row lg:px-0 lg:py-0">
      {/* Left hero — desktop only (Figma: brand, big Welcome, illustration) */}
      <div className="hidden lg:flex lg:min-h-dvh lg:flex-1 lg:flex-col lg:px-16 lg:py-10 xl:px-24">
        <div className="flex items-center gap-2">
          <Image src="/logo.png" alt="" width={28} height={28} className="size-7" />
          <span className="text-[16px] font-bold text-ink">Radiues</span>
        </div>
        <h1 className="mt-12 text-[64px] font-bold leading-none tracking-tight text-ink">
          Welcome
        </h1>
        <p className="mt-5 max-w-sm text-[17px] leading-relaxed text-cocoa">
          You&apos;ll get smarter responses and can upload files, images, and
          more.
        </p>
        <Image
          src="/illustrations/login-hero.png"
          alt=""
          width={569}
          height={530}
          priority
          className="mt-6 w-full max-w-[540px] self-center"
        />
      </div>

      {/* Form column */}
      <div className="flex w-full flex-col lg:min-h-dvh lg:w-[600px] lg:justify-center lg:px-16 lg:pb-16">
        <div className="flex justify-center lg:hidden">
          <Image
            src="/logo.png"
            alt="Radiues"
            width={56}
            height={56}
            priority
            className="h-14 w-14"
          />
        </div>

        <h1 className="mt-6 text-center text-[30px] font-bold text-ink lg:hidden">
          Welcome
        </h1>
        <p className="mt-2 text-center text-[13px] leading-relaxed text-cocoa lg:hidden">
          You&apos;ll get smarter responses and can upload files, images, and more.
        </p>

        <form onSubmit={onSubmit} className="mt-7 flex flex-col gap-4 lg:mt-0">
        <Input
          label="Email address"
          type="email"
          autoComplete="email"
          placeholder="admin@gmail.com"
          icon={<Mail size={17} />}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        <Input
          label="Password"
          type={showPw ? "text" : "password"}
          autoComplete="current-password"
          placeholder="••••••••••"
          icon={<Lock size={17} />}
          trailing={
            <button
              type="button"
              onClick={() => setShowPw((v) => !v)}
              aria-label={showPw ? "Hide password" : "Show password"}
              className="rounded-full p-1.5 text-cocoa/60 hover:text-cocoa"
            >
              {showPw ? <EyeOff size={17} /> : <Eye size={17} />}
            </button>
          }
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />

        <Link
          href="/forgot"
          className="-mt-2 self-end text-[13px] font-semibold text-accent hover:underline"
        >
          Forgot password?
        </Link>

        {error && <p className="text-[13px] text-danger">{error}</p>}
        {info && <p className="text-[13px] text-cocoa">{info}</p>}

        <Button type="submit" disabled={busy} className="mt-2 w-full">
          {busy ? "Signing in…" : "Sign in"}
        </Button>
      </form>

      <div className="mt-7 flex items-center gap-3 text-[12px] text-cocoa/70">
        <span className="h-px flex-1 bg-line" />
        Or continue with
        <span className="h-px flex-1 bg-line" />
      </div>

      <div className="mt-5 flex flex-col gap-3">
        <button
          type="button"
          onClick={() => setInfo("Phone sign-in is coming soon — use email for now.")}
          className="flex h-12 w-full items-center justify-center gap-2 rounded-pill border border-line bg-card text-[14px] font-semibold text-ink transition-colors hover:bg-beige/40"
        >
          <Phone size={16} className="text-cocoa" />
          Continue with phone
        </button>
        <div className="grid grid-cols-2 gap-3">
          <GoogleButton onError={setError} />
          <button
            type="button"
            onClick={() => setInfo("Apple sign-in is coming soon — use email for now.")}
            className="flex h-12 w-full items-center justify-center gap-2 rounded-pill border border-line bg-card text-[14px] font-semibold text-ink transition-colors hover:bg-beige/40"
          >
            <Apple size={17} className="text-ink" /> Apple
          </button>
        </div>
      </div>

      <p className="mt-9 text-center text-[13px] text-cocoa">
        Don&apos;t have an account?{" "}
        <Link href="/signup" className="font-bold text-ink hover:text-accent">
          Create an account
        </Link>
      </p>
      </div>
    </div>
  );
}
