"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useBackTo } from "@/lib/navHistory";
import {
  ArrowLeft,
  Search,
  Mic,
  Phone,
  ChevronRight,
  Car,
  ShoppingBag,
  CreditCard,
  Tag,
  UserRound,
  MessageCircle,
  BookOpen,
  Headset,
} from "lucide-react";
import { api } from "@/lib/api";
import { useToast } from "@/components/ui/Toast";
import { useI18n } from "@/components/i18n/I18nContext";
import { cn } from "@/lib/cn";

// Figma "Help Center": a search field with voice input, an orange hero with a
// call button, Top Topics, then "Still need help?".
//
// Topics come from the support knowledge base rather than being written into
// this file, so the Help Centre, the article pages and the chat assistant all
// answer from one source. Search runs against the same set.

type Topic = { slug: string; group: string; title: string; summary: string };

const GROUP_ICON: Record<string, typeof Car> = {
  rides: Car,
  orders: ShoppingBag,
  payments: CreditCard,
  offers: Tag,
  account: UserRound,
};

// The founder's line, as drawn on the Contact Us frame.
const SUPPORT_PHONE = "+917396144250";

export default function HelpCenterPage() {
  const { t } = useI18n();
  return (
    <Suspense
      fallback={
        <div className="min-h-dvh bg-acct-bg px-4 py-10 text-center text-[13px] text-acct-muted">
          {t("common.loading")}
        </div>
      }
    >
      <HelpCenter />
    </Suspense>
  );
}

function HelpCenter() {
  const router = useRouter();
  const goBack = useBackTo("/profile");
  const { toast } = useToast();
  const { t } = useI18n();
  // Order pages and the ride tracker link here with ?order=<id> so help can
  // start already attached to the order in question.
  const orderId = useSearchParams().get("order");
  const [startingOrderChat, setStartingOrderChat] = useState(false);
  const [query, setQuery] = useState("");
  const [topics, setTopics] = useState<Topic[] | null>(null);
  const [listening, setListening] = useState(false);

  const load = useCallback((q: string) => {
    api<{ topics: Topic[] }>(`/api/support/topics${q ? `?q=${encodeURIComponent(q)}` : ""}`)
      .then((d) => setTopics(d.topics))
      .catch(() => setTopics([]));
  }, []);

  useEffect(() => {
    const id = setTimeout(() => load(query), query ? 250 : 0);
    return () => clearTimeout(id);
  }, [query, load]);

  /** Voice search, using the same Web Speech API the chat bar uses. */
  function startVoice() {
    type SpeechCtor = new () => {
      lang: string;
      interimResults: boolean;
      start(): void;
      stop(): void;
      onresult: ((e: { results: { 0: { 0: { transcript: string } } } }) => void) | null;
      onend: (() => void) | null;
      onerror: (() => void) | null;
    };
    const w = window as unknown as {
      SpeechRecognition?: SpeechCtor;
      webkitSpeechRecognition?: SpeechCtor;
    };
    const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
    if (!Ctor) return;

    const rec = new Ctor();
    rec.lang = "en-IN";
    rec.interimResults = false;
    rec.onresult = (e) => setQuery(e.results[0][0].transcript);
    rec.onend = () => setListening(false);
    rec.onerror = () => setListening(false);
    setListening(true);
    rec.start();
  }

  // The design's five Top Topics: one representative row per group.
  const top = (topics ?? []).filter((t, i, all) =>
    query ? true : all.findIndex((x) => x.group === t.group) === i,
  );

  async function startOrderChat() {
    setStartingOrderChat(true);
    try {
      const d = await api<{ chat: { id: string } }>("/api/support/chats", {
        method: "POST",
        json: { ...(orderId ? { orderId } : {}) },
      });
      router.push(`/profile/help/chat/${d.chat.id}`);
    } catch {
      toast(t("pp.hc.chatFailed"));
      setStartingOrderChat(false);
    }
  }

  return (
    <div className="min-h-dvh bg-acct-bg">
      <div className="mx-auto w-full max-w-xl px-4 pb-10 lg:max-w-[780px] lg:px-6">
        <div className="flex items-center py-4">
          <button
            onClick={goBack}
            aria-label={t("common.back")}
            className="tap-target flex size-9 shrink-0 items-center justify-center rounded-full bg-card shadow-soft transition-colors hover:bg-acct-bg"
          >
            <ArrowLeft size={18} className="text-acct-ink" />
          </button>
          <h1 className="flex-1 pr-9 text-center text-[17px] font-extrabold text-acct-ink">
            {t("pp.profile.helpCentre")}
          </h1>
        </div>

        <div className="flex items-center gap-2 rounded-pill bg-card px-4 py-3 shadow-soft">
          <Search size={17} className="shrink-0 text-acct-muted" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("pp.hc.searchPh")}
            aria-label={t("pp.hc.searchLabel")}
            className="min-w-0 flex-1 bg-transparent text-[16px] text-acct-ink outline-none placeholder:text-acct-muted"
          />
          <button
            onClick={startVoice}
            aria-label={t("pp.hc.voiceSearch")}
            className={cn(
              "tap-target shrink-0 rounded-full p-1",
              listening ? "text-acct-accent" : "text-acct-muted hover:text-acct-ink",
            )}
          >
            <Mic size={17} />
          </button>
        </div>

        {orderId && (
          <button
            onClick={startOrderChat}
            disabled={startingOrderChat}
            className="mt-4 flex w-full items-center gap-3 rounded-[18px] bg-card px-4 py-3.5 text-left shadow-soft transition-colors hover:bg-acct-bg disabled:opacity-60"
          >
            <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-acct-tint">
              <Headset size={18} className="text-acct-accent" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[15px] font-bold text-acct-ink">
                {t("pp.hc.orderHelp")}
              </span>
              <span className="block text-[12px] text-acct-muted">
                {startingOrderChat ? t("pp.hc.starting") : t("pp.hc.orderHelpSub")}
              </span>
            </span>
            <ChevronRight size={17} className="shrink-0 text-acct-muted" />
          </button>
        )}

        {/* Hero */}
        <div
          className="mt-4 rounded-[18px] p-5 text-white shadow-lift"
          style={{ background: "linear-gradient(135deg, #e8651a 0%, #b33b06 100%)" }}
        >
          <p className="text-[17px] font-extrabold">{t("pp.hc.heroTitle")}</p>
          <p className="mt-1 text-[12px] text-white/80">{t("pp.hc.heroSub")}</p>
          <a
            href={`tel:${SUPPORT_PHONE}`}
            className="mt-4 inline-flex items-center gap-2 rounded-pill bg-black/25 px-4 py-2.5 text-[14px] font-bold text-white backdrop-blur transition-colors hover:bg-black/35"
          >
            <Phone size={15} /> {t("pp.hc.callSupport")}
          </a>
        </div>

        <p className="mb-2 mt-6 px-1 text-[16px] font-extrabold text-acct-ink">
          {query ? t("pp.hc.results") : t("pp.hc.topTopics")}
        </p>

        <div className="overflow-hidden rounded-[18px] bg-card shadow-soft">
          {topics === null ? (
            <p className="px-4 py-8 text-center text-[13px] text-acct-muted">
              {t("common.loading")}
            </p>
          ) : top.length === 0 ? (
            <div className="px-4 py-8 text-center">
              <p className="text-[14px] font-semibold text-acct-ink">
                {t("pp.hc.noMatch")}
              </p>
              <p className="mt-1 text-[13px] text-acct-muted">
                {t("pp.hc.noMatchSub")}
              </p>
            </div>
          ) : (
            top.map((t, i) => {
              const Icon = GROUP_ICON[t.group] ?? ShoppingBag;
              return (
                <Link
                  key={t.slug}
                  href={`/profile/help/topics/${t.slug}`}
                  className={cn(
                    "flex items-center gap-3.5 px-4 py-3.5 transition-colors hover:bg-acct-bg",
                    i < top.length - 1 && "border-b border-line",
                  )}
                >
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-acct-tint">
                    <Icon size={17} className="text-acct-accent" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="line-clamp-2 text-[15px] font-semibold text-acct-ink">
                      {t.title}
                    </span>
                    {query && (
                      <span className="line-clamp-2 text-[12px] text-acct-muted">
                        {t.summary}
                      </span>
                    )}
                  </span>
                  <ChevronRight size={17} className="shrink-0 text-acct-muted" />
                </Link>
              );
            })
          )}
        </div>

        <p className="mb-2 mt-6 px-1 text-[16px] font-extrabold text-acct-ink">
          {t("pp.hc.stillNeed")}
        </p>

        <div className="overflow-hidden rounded-[18px] bg-card shadow-soft">
          <Link
            href="/profile/help/contact"
            className="flex items-center gap-3.5 border-b border-line px-4 py-3.5 transition-colors hover:bg-acct-bg"
          >
            <span className="flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-acct-tint">
              <MessageCircle size={17} className="text-acct-accent" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[15px] font-bold text-acct-ink">
                {t("pp.profile.contact")}
              </span>
              <span className="block text-[12px] text-acct-muted">
                {t("pp.hc.contactSub")}
              </span>
            </span>
            <ChevronRight size={17} className="shrink-0 text-acct-muted" />
          </Link>
          <Link
            href="/profile/help/faqs"
            className="flex items-center gap-3.5 px-4 py-3.5 transition-colors hover:bg-acct-bg"
          >
            <span className="flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-acct-tint">
              <BookOpen size={17} className="text-acct-accent" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[15px] font-bold text-acct-ink">
                {t("pp.hc.faqs")}
              </span>
              <span className="block text-[12px] text-acct-muted">
                {t("pp.hc.faqsSub")}
              </span>
            </span>
            <ChevronRight size={17} className="shrink-0 text-acct-muted" />
          </Link>
        </div>
      </div>
    </div>
  );
}
