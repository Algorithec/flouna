"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api, ApiClientError } from "@/lib/api";

export type Role = "user" | "developer" | "admin" | "super_admin";

export type Operator = {
  id: string;
  name: string;
  email: string;
  role: Role;
};

// Does `role` satisfy `needed`? Mirrors the server: super_admin ⊇ admin;
// developer is a sibling. Used only to render the right UI — the server
// re-authorizes every request regardless of what we show.
export function roleSatisfies(role: Role, needed: Role): boolean {
  if (role === needed) return true;
  if (needed === "admin" && role === "super_admin") return true;
  return false;
}

type State =
  | { status: "loading" }
  | { status: "ok"; operator: Operator }
  | { status: "denied" };

// Guards a console page. Uses the step-up-aware /api/console/whoami probe: it
// succeeds only for an operator whose session has cleared 2FA. Anything else —
// not an operator (404), step-up needed (403 step_up_required), or no session —
// sends them to the console login (which runs the password + OTP flow). We need
// the account's name/email too, so we pair it with /api/auth/me.
//
// Only an answer about the session sends anyone to the login. A rate limit, a
// server error or a dropped connection used to do the same, so an operator
// working quickly through the queue hit the console's limit and appeared to
// be signed out mid-task. Those are retried, with the page held where it is.
export function useOperator(accept: Role[] = ["developer", "admin", "super_admin"]) {
  const router = useRouter();
  const [state, setState] = useState<State>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const deny = () => {
      if (cancelled) return;
      setState({ status: "denied" });
      router.replace("/console/login");
    };

    const attempt = (n: number) => {
      Promise.all([
        api<{ id: string; role: Role }>("/api/console/whoami"),
        api<{ user: Operator }>("/api/auth/me"),
      ])
        .then(([who, me]) => {
          if (cancelled) return;
          const allowed =
            who.role !== "user" && accept.some((r) => roleSatisfies(who.role, r));
          if (allowed) setState({ status: "ok", operator: { ...me.user, role: who.role } });
          else deny();
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          const aboutSession =
            err instanceof ApiClientError && [401, 403, 404].includes(err.status);
          if (aboutSession) return deny();
          retry = setTimeout(() => attempt(n + 1), Math.min(2000 * 2 ** n, 15000));
        });
    };
    attempt(0);

    return () => {
      cancelled = true;
      clearTimeout(retry);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return state;
}
