"use client";

import { useCallback, useEffect, useState } from "react";
import { useEscapeToClose } from "@/lib/useEscapeToClose";
import { useBackTo } from "@/lib/navHistory";
import { ArrowLeft, UserX, Plus, X } from "lucide-react";
import { api } from "@/lib/api";
import { useToast } from "@/components/ui/Toast";
import { useI18n } from "@/components/i18n/I18nContext";

// Privacy & Security → Blocked Users.
//
// Blocking is enforced where the product actually puts two accounts in the same
// room: group orders. A blocked person can't join a cart you host, and you
// won't be pulled into one they host either. That is stated on the screen,
// because a block that quietly does less than the word implies is worse than no
// block at all.

type Blocked = {
  id: string;
  createdAt: string;
  user: { id: string; name: string; email: string; avatarUrl: string | null };
};

export default function BlockedUsersPage() {
  const goBack = useBackTo("/profile/privacy");
  const { toast } = useToast();
  const { t } = useI18n();
  const [rows, setRows] = useState<Blocked[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  useEscapeToClose(adding && !busy, () => setAdding(false));
  const [error, setError] = useState("");

  const load = useCallback(() => {
    api<{ blocked: Blocked[] }>("/api/users/blocked")
      .then((d) => setRows(d.blocked))
      .catch(() => setRows([]));
  }, []);
  useEffect(load, [load]);

  async function block(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const d = await api<{ blocked: Blocked }>("/api/users/blocked", {
        method: "POST",
        json: { email: email.trim() },
      });
      setRows((r) => [d.blocked, ...(r ?? []).filter((x) => x.user.id !== d.blocked.user.id)]);
      setEmail("");
      setAdding(false);
      toast(t("pp.blk.blocked"));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("pp.blk.blockFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function unblock(row: Blocked) {
    const previous = rows;
    setRows((r) => r?.filter((x) => x.id !== row.id) ?? null);
    try {
      await api(`/api/users/blocked/${row.id}`, { method: "DELETE" });
      toast(`${t("pp.blk.unblock")} ${row.user.name}`);
    } catch {
      setRows(previous ?? null);
      toast(t("pp.blk.unblockFailed"));
    }
  }

  return (
    <div className="min-h-dvh bg-acct-bg">
      <div className="mx-auto w-full max-w-xl px-4 pb-10 lg:max-w-[780px] lg:px-6">
        <div className="flex items-center py-4">
          <button
            onClick={goBack}
            aria-label={t("common.back")}
            className="tap-target flex size-9 items-center justify-center rounded-full bg-card shadow-soft transition-colors hover:bg-acct-bg"
          >
            <ArrowLeft size={18} className="text-acct-ink" />
          </button>
          <h1 className="flex-1 text-center text-[17px] font-extrabold text-acct-ink">
            {t("pp.priv.blocked")}
          </h1>
          <button
            onClick={() => {
              setError("");
              setAdding(true);
            }}
            aria-label={t("pp.blk.blockSomeone")}
            className="tap-target flex size-9 items-center justify-center rounded-full text-acct-accent transition-colors hover:bg-acct-tint"
          >
            <Plus size={20} />
          </button>
        </div>

        <div className="overflow-hidden rounded-[18px] bg-card shadow-soft">
          {rows === null ? (
            <p className="px-4 py-8 text-center text-[13px] text-acct-muted">
              {t("common.loading")}
            </p>
          ) : rows.length === 0 ? (
            <div className="px-4 py-10 text-center">
              <span className="mx-auto flex size-12 items-center justify-center rounded-full bg-acct-tint">
                <UserX size={22} className="text-acct-accent" />
              </span>
              <p className="mt-3 text-[15px] font-bold text-acct-ink">
                {t("pp.blk.empty")}
              </p>
              <p className="mt-1 text-[13px] text-acct-muted">
                {t("pp.blk.emptySub")}
              </p>
            </div>
          ) : (
            rows.map((row) => (
              <div
                key={row.id}
                className="flex items-center gap-3 border-b border-line px-4 py-3.5 last:border-b-0"
              >
                <span className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-full bg-acct-tint text-[15px] font-bold text-acct-accent">
                  {row.user.avatarUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={row.user.avatarUrl} alt="" className="size-full object-cover" />
                  ) : (
                    row.user.name.trim()[0]?.toUpperCase() ?? "?"
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[15px] font-bold text-acct-ink">
                    {row.user.name}
                  </span>
                  <span className="block truncate text-[12px] text-acct-muted">
                    {row.user.email}
                  </span>
                </span>
                <button
                  onClick={() => unblock(row)}
                  className="tap-target shrink-0 rounded-pill border border-line px-3.5 py-1.5 text-[12px] font-semibold text-acct-ink transition-colors hover:bg-acct-bg"
                >
                  {t("pp.blk.unblock")}
                </button>
              </div>
            ))
          )}
        </div>

        <p className="mt-4 px-1 text-[12px] leading-relaxed text-acct-muted">
          {t("pp.blk.footer")}
        </p>
      </div>

      {adding && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 lg:items-center"
          onClick={() => !busy && setAdding(false)}
        >
          <form
            role="dialog"
            aria-label={t("pp.blk.blockSomeone")}
            onSubmit={block}
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-md rounded-t-3xl bg-card p-5 lg:rounded-3xl"
          >
            <div className="flex items-center justify-between">
              <p className="text-[16px] font-bold text-acct-ink">{t("pp.blk.blockSomeone")}</p>
              <button
                type="button"
                onClick={() => setAdding(false)}
                aria-label={t("common.close")}
                className="rounded-full p-1.5 text-acct-muted hover:bg-acct-bg"
              >
                <X size={18} />
              </button>
            </div>
            <p className="mt-1 text-[13px] text-acct-muted">
              {t("pp.blk.emailHint")}
            </p>
            <input
              autoFocus
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="name@example.com"
              className="mt-4 h-12 w-full rounded-[12px] border border-line bg-acct-bg px-3.5 text-[15px] text-acct-ink outline-none focus:border-acct-accent"
              required
            />
            {error && (
              <p role="alert" className="mt-2 text-[13px] text-danger">
                {error}
              </p>
            )}
            <button
              type="submit"
              disabled={busy || !email.trim()}
              className="mt-4 h-[52px] w-full rounded-pill bg-acct-accent text-[15px] font-bold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {busy ? t("pp.blk.blocking") : t("pp.blk.block")}
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
