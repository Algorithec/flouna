"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useBackTo } from "@/lib/navHistory";
import { ArrowLeft, SendHorizonal, Headset, Star, ChevronRight } from "lucide-react";
import { api } from "@/lib/api";
import { useToast } from "@/components/ui/Toast";
import { useI18n } from "@/components/i18n/I18nContext";
import { cn } from "@/lib/cn";

// Help Centre chat.
//
// The assistant is deterministic and reads the customer's own orders, so this
// screen's job is to make that legible: quick replies for the paths it knows,
// a free-text box for everything else, and an unmissable way to reach a person.
//
// When a conversation ends the rating card takes over the composer rather than
// appearing as a dialog on top of it — the conversation is finished, so the
// input has nothing left to do.

type Option = { label: string; value: string };
type Message = {
  id: string;
  role: "user" | "bot" | "agent";
  body: string;
  options: Option[];
  createdAt: string;
};
type Chat = {
  id: string;
  status: "open" | "resolved" | "escalated" | "closed";
  topic: string | null;
  ticketId: string | null;
  ratingStars: number | null;
  endedAt: string | null;
  messages: Message[];
};

export default function SupportChatPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const { toast } = useToast();
  const { t } = useI18n();
  // Was router.push("/profile/help"), which pushed a second Help entry and
  // made back on Help go forward into this chat again, forever.
  const goBack = useBackTo("/profile/help");
  const [chat, setChat] = useState<Chat | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [stars, setStars] = useState(0);
  const [comment, setComment] = useState("");
  const [loadFailed, setLoadFailed] = useState(false);
  const endRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(() => {
    api<{ chat: Chat }>(`/api/support/chats/${params.id}`)
      .then((d) => {
        setChat(d.chat);
        setLoadFailed(false);
      })
      // A failure left `chat` null, which is the same state as the first
      // render, so the screen said "Loading…" for as long as the customer was
      // willing to wait. Somebody who has just been told to raise it here is
      // the last person who should be left watching a spinner that is not
      // waiting for anything.
      .catch(() => setLoadFailed(true));
  }, [params.id]);
  useEffect(load, [load]);

  // Keep the newest message in view as the conversation grows.
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [chat?.messages.length]);

  // `fromComposer` is what the customer typed, as opposed to a quick reply,
  // whose value is a machine token and has no business appearing in the box.
  async function send(body: string, fromComposer = false) {
    const text = body.trim();
    if (!text || busy) return;
    setBusy(true);
    setDraft("");
    try {
      const d = await api<{ chat: Chat; escalated: boolean; ticketId: string | null }>(
        `/api/support/chats/${params.id}/messages`,
        { method: "POST", json: { body: text } },
      );
      setChat(d.chat);
      if (d.escalated) toast(t("pp.chat.passedToTeam"));
    } catch (err) {
      toast(err instanceof Error ? err.message : t("pp.chat.sendFailed"));
      // Put the message back in the box. The composer was cleared before the
      // request, so a send that failed threw away what the customer had
      // written and left them nothing to retry — on the screen whose whole
      // purpose is describing a problem, often at some length. Only if they
      // have not started typing something else in the meantime.
      if (fromComposer) setDraft((cur) => (cur.trim() ? cur : text));
    } finally {
      setBusy(false);
    }
  }

  async function submitRating() {
    if (!stars) return;
    setBusy(true);
    try {
      const d = await api<{ chat: Chat }>(`/api/support/chats/${params.id}/rating`, {
        method: "POST",
        json: { stars, ...(comment.trim() ? { comment: comment.trim() } : {}) },
      });
      setChat(d.chat);
      toast(t("pp.chat.thanksFeedback"));
      // Back to the Help Centre once the conversation is genuinely over.
      // The conversation is over, so it should not be re-enterable by back.
      setTimeout(() => router.replace("/profile/help"), 1200);
    } catch (err) {
      toast(err instanceof Error ? err.message : t("pp.chat.rateFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function endChat() {
    setBusy(true);
    try {
      const d = await api<{ chat: Chat }>(`/api/support/chats/${params.id}/end`, {
        method: "POST",
      });
      setChat(d.chat);
    } catch {
      toast(t("pp.chat.endFailed"));
    } finally {
      setBusy(false);
    }
  }

  if (!chat) {
    return (
      <div className="min-h-dvh bg-acct-bg px-4 py-10 text-center text-[13px] text-acct-muted">
        {loadFailed ? (
          <>
            <p className="text-acct-ink">{t("pp.chat.loadFailed")}</p>
            <div className="mt-4 flex flex-col items-center gap-3">
              <button
                onClick={load}
                className="tap-target rounded-pill border border-line bg-card px-5 py-2.5 text-[14px] font-bold text-acct-ink"
              >
                {t("ipay.tryAgain")}
              </button>
              <Link href="/profile/help" className="font-semibold hover:underline">
                {t("pp.chat.backToHelp")}
              </Link>
            </div>
          </>
        ) : (
          t("common.loading")
        )}
      </div>
    );
  }

  const ended = !!chat.endedAt;
  const awaitingRating = ended && chat.ratingStars === null;
  const lastBot = [...chat.messages].reverse().find((m) => m.role !== "user");
  const quickReplies = chat.status === "open" ? (lastBot?.options ?? []) : [];

  return (
    <div className="flex min-h-dvh flex-col bg-acct-bg">
      <div className="mx-auto flex w-full max-w-xl flex-1 flex-col px-4 pb-4 lg:max-w-[780px] lg:px-6">
        <div className="flex items-center gap-3 py-4">
          <button
            onClick={goBack}
            aria-label={t("common.back")}
            className="tap-target flex size-9 shrink-0 items-center justify-center rounded-full bg-card shadow-soft transition-colors hover:bg-acct-bg"
          >
            <ArrowLeft size={18} className="text-acct-ink" />
          </button>
          <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-acct-tint">
            <Headset size={17} className="text-acct-accent" />
          </span>
          <span className="min-w-0 flex-1">
            <h1 className="truncate text-[15px] font-extrabold text-acct-ink">
              {t("pp.chat.title")}
            </h1>
            <span className="block text-[11px] font-semibold text-success">
              {chat.status === "escalated"
                ? t("pp.chat.withTeam")
                : ended
                  ? t("pp.chat.ended")
                  : t("pp.chat.online")}
            </span>
          </span>
          {!ended && (
            <button
              onClick={endChat}
              disabled={busy}
              className="tap-target shrink-0 rounded-pill border border-line px-3 py-1.5 text-[12px] font-semibold text-acct-muted transition-colors hover:bg-card disabled:opacity-50"
            >
              {t("pp.chat.endChat")}
            </button>
          )}
        </div>

        {/* Transcript */}
        <div className="flex flex-1 flex-col gap-3 py-2">
          {chat.messages.map((m) => {
            const mine = m.role === "user";
            return (
              <div
                key={m.id}
                className={cn("flex", mine ? "justify-end" : "justify-start")}
              >
                <div
                  className={cn(
                    "max-w-[85%] whitespace-pre-line rounded-[16px] px-4 py-2.5 text-[14px] leading-relaxed shadow-soft",
                    mine
                      ? "rounded-br-[4px] bg-acct-accent text-white"
                      : "rounded-bl-[4px] bg-card text-acct-ink",
                  )}
                >
                  {m.body}
                </div>
              </div>
            );
          })}

          {chat.status === "escalated" && chat.ticketId && (
            <Link
              href="/profile/help"
              className="flex items-center gap-3 rounded-[16px] border border-line bg-card px-4 py-3.5 shadow-soft transition-colors hover:bg-acct-bg"
            >
              <span className="min-w-0 flex-1">
                <span className="block text-[14px] font-bold text-acct-ink">
                  {t("pp.chat.teamHasIt")}
                </span>
                <span className="block text-[12px] text-acct-muted">
                  {t("pp.chat.teamHasItSub")}
                </span>
              </span>
              <ChevronRight size={16} className="shrink-0 text-acct-muted" />
            </Link>
          )}

          <div ref={endRef} />
        </div>

        {/* Quick replies */}
        {quickReplies.length > 0 && !busy && (
          <div className="flex flex-wrap gap-2 pb-2">
            {quickReplies.map((o) => (
              <button
                key={o.value}
                onClick={() => send(o.value)}
                className="tap-target rounded-pill border border-acct-accent bg-card px-3.5 py-1.5 text-[13px] font-semibold text-acct-accent transition-colors hover:bg-acct-tint"
              >
                {o.label}
              </button>
            ))}
          </div>
        )}

        {/* Composer, or the rating card once the chat is over */}
        {awaitingRating ? (
          <div className="rounded-[18px] bg-card p-5 text-center shadow-soft">
            <p className="text-[16px] font-extrabold text-acct-ink">
              {t("pp.chat.howDidWeDo")}
            </p>
            <p className="mt-1 text-[13px] text-acct-muted">
              {t("pp.chat.ratingSub")}
            </p>
            <div className="mt-4 flex justify-center gap-2">
              {[1, 2, 3, 4, 5].map((n) => (
                <button
                  key={n}
                  onClick={() => setStars(n)}
                  aria-label={`${n} star${n === 1 ? "" : "s"}`}
                  className="tap-target transition-transform hover:scale-110"
                >
                  <Star
                    size={30}
                    className={n <= stars ? "text-acct-accent" : "text-line"}
                    fill={n <= stars ? "currentColor" : "none"}
                  />
                </button>
              ))}
            </div>
            {stars > 0 && (
              <>
                <textarea
                  value={comment}
                  onChange={(e) => setComment(e.target.value.slice(0, 500))}
                  rows={2}
                  placeholder={
                    stars <= 2
                      ? t("pp.chat.whatWrong")
                      : t("pp.chat.anythingToAdd")
                  }
                  className="mt-4 w-full resize-none rounded-[12px] border border-line bg-acct-bg p-3 text-[14px] text-acct-ink outline-none focus:border-acct-accent"
                />
                <button
                  onClick={submitRating}
                  disabled={busy}
                  className="mt-3 h-[50px] w-full rounded-pill bg-acct-accent text-[15px] font-bold text-white transition-opacity hover:opacity-90 disabled:opacity-60"
                >
                  {busy ? t("pp.chat.sending") : t("pp.chat.submitRating")}
                </button>
              </>
            )}
            <button
              onClick={() => router.replace("/profile/help")}
              className="mt-3 text-[13px] font-semibold text-acct-muted hover:underline"
            >
              {t("pp.chat.skip")}
            </button>
          </div>
        ) : ended ? (
          <div className="rounded-[18px] bg-card p-5 text-center shadow-soft">
            <p className="text-[15px] font-bold text-acct-ink">
              {t("pp.chat.youRated").replace("{n}", String(chat.ratingStars))}
            </p>
            <Link
              href="/profile/help"
              className="mt-3 inline-flex h-[46px] items-center rounded-pill border border-line px-6 text-[14px] font-bold text-acct-ink transition-colors hover:bg-acct-bg"
            >
              {t("pp.chat.backToHelp")}
            </Link>
          </div>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void send(draft, true);
            }}
            className="flex items-center gap-2 rounded-pill bg-card px-4 py-2 shadow-soft"
          >
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={t("pp.chat.typeMessage")}
              aria-label={t("pp.chat.typeMessage")}
              maxLength={1000}
              className="min-w-0 flex-1 bg-transparent py-2 text-[15px] text-acct-ink outline-none placeholder:text-acct-muted"
            />
            <button
              type="submit"
              disabled={busy || !draft.trim()}
              aria-label={t("common.send")}
              className="flex size-9 shrink-0 items-center justify-center rounded-full bg-acct-accent text-white transition-opacity hover:opacity-90 disabled:opacity-40"
            >
              <SendHorizonal size={16} />
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
