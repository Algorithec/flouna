"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  MapPin,
  Pizza,
  Send,
  RotateCcw,
  ShoppingBag,
  Car,
  Utensils,
  Coffee,
  Moon,
  Plus,
  Search as SearchIcon,
  type LucideIcon,
} from "lucide-react";
import { api } from "@/lib/api";
import { rupees } from "@/lib/money";
import {
  ComboRecommendation,
  FoodRecommendation,
  RideRecommendation,
  ShopRecommendation,
} from "@/components/chat/RecommendationCards";
import { VoiceButton } from "@/components/chat/VoiceButton";
import { ThinkingSteps } from "@/components/chat/ThinkingSteps";
import { PredictionBanner } from "@/components/chat/PredictionBanner";
import { useI18n } from "@/components/i18n/I18nContext";
import { FadeIn, Stagger, StaggerItem } from "@/components/ui/motion";
import { type TILE_THEMES } from "@/components/ui/CategoryTile";
import type { ChatMessage, FoodQuote } from "@/components/chat/types";
import { cn } from "@/lib/cn";

type Usual = FoodQuote & { timesOrdered: number };

// Server-built personalized chips. `icon`/`theme` are string keys we map to
// real components/themes here (they can't cross the JSON boundary).
type Suggestion = {
  label: string;
  prompt: string;
  icon: string;
  theme: keyof typeof TILE_THEMES;
};

const ICONS: Record<string, LucideIcon> = {
  pizza: Pizza,
  mapPin: MapPin,
  shoppingBag: ShoppingBag,
  car: Car,
  utensils: Utensils,
  coffee: Coffee,
  moon: Moon,
  rotate: RotateCcw,
};

// Shown instantly while the personalized set loads (and if the request fails).
const FALLBACK_SUGGESTIONS: Suggestion[] = [
  { label: "Order pizza", prompt: "Order a pizza under ₹300", icon: "pizza", theme: "orange" },
  { label: "Book a ride", prompt: "Book a ride to ", icon: "mapPin", theme: "blue" },
  { label: "Shop a laptop", prompt: "Find me a gaming laptop under ₹70000", icon: "shoppingBag", theme: "purple" },
];

export default function ChatHomePage() {
  return (
    <Suspense fallback={null}>
      <ChatHome />
    </Suspense>
  );
}

function ChatHome() {
  const { t } = useI18n();
  const router = useRouter();
  const chatParam = useSearchParams().get("chat");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sessionId, setSessionId] = useState<string | undefined>();
  const [thinking, setThinking] = useState(false);
  const [usual, setUsual] = useState<Usual | null>(null);
  const [suggestions, setSuggestions] = useState<Suggestion[]>(FALLBACK_SUGGESTIONS);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api<{ usual: Usual | null }>("/api/users/usual")
      .then((d) => setUsual(d.usual))
      .catch(() => setUsual(null));
    api<{ suggestions: Suggestion[] }>("/api/users/suggestions")
      .then((d) => d.suggestions.length > 0 && setSuggestions(d.suggestions))
      .catch(() => {
        /* keep fallbacks */
      });
  }, []);

  // "New Chat" (no ?chat param) resets the thread — reset-during-render.
  const [prevChat, setPrevChat] = useState(chatParam);
  if (prevChat !== chatParam) {
    setPrevChat(chatParam);
    if (!chatParam) {
      setMessages([]);
      setSessionId(undefined);
    }
  }

  // Opening a chat from the sidebar loads its stored messages.
  useEffect(() => {
    if (!chatParam || chatParam === sessionId) return;
    api<{ session: { id: string; messages: ChatMessage[] } }>(
      `/api/chat/sessions/${chatParam}`,
    )
      .then((d) => {
        setSessionId(d.session.id);
        setMessages(d.session.messages);
      })
      .catch(() => router.replace("/home"));
  }, [chatParam, sessionId, router]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, thinking]);

  async function send(text: string) {
    const message = text.trim();
    if (!message || thinking) return;
    setInput("");
    setMessages((m) => [
      ...m,
      { id: `u-${Date.now()}`, role: "user", content: message },
    ]);
    setThinking(true);
    try {
      const d = await api<{ sessionId: string; message: ChatMessage }>(
        "/api/chat/message",
        { method: "POST", json: { message, sessionId } },
      );
      setSessionId(d.sessionId);
      setMessages((m) => [...m, d.message]);
      if (!sessionId) {
        // Keep the URL in sync so the sidebar highlights this chat and
        // refresh/share restores the conversation.
        setPrevChat(d.sessionId);
        router.replace(`/home?chat=${d.sessionId}`, { scroll: false });
      }
    } catch (err) {
      setMessages((m) => [
        ...m,
        {
          id: `e-${Date.now()}`,
          role: "assistant",
          content:
            err instanceof Error ? err.message : "Something went wrong — try again.",
        },
      ]);
    } finally {
      setThinking(false);
    }
  }

  const empty = messages.length === 0;

  return (
    <div
      className={cn(
        "mx-auto flex h-[calc(100dvh-3.5rem)] w-full max-w-2xl flex-col px-4 lg:h-dvh lg:px-6",
        empty ? "lg:max-w-3xl" : "lg:max-w-5xl",
      )}
    >
      {empty ? (
        <div className="flex flex-1 flex-col items-center justify-center px-2 text-center">
          {/* Proactive heads-up — the engine getting ahead of the user (rain
              near their usual ride, etc.). Renders nothing when quiet. */}
          <div className="mb-6 w-full max-w-md">
            <PredictionBanner
              onBook={(drop) => setInput(`Book a ride to ${drop}`)}
            />
          </div>

          {/* Hero heading — exact Figma: navy line 1, terracotta line 2 */}
          <FadeIn y={10}>
            <h1 className="flex flex-col gap-0.5 text-[26px] font-bold leading-[1.2] tracking-tight lg:text-[44px]">
              <span className="text-navy">{t("chat.heading1")}</span>
              <span className="text-terracotta">{t("chat.heading2")}</span>
            </h1>
          </FadeIn>

          {/* Quick chips — flat beige pills, matching the design */}
          <Stagger delayChildren={0.15} className="mt-6 flex flex-wrap items-center justify-center gap-3">
            {suggestions.slice(0, 3).map((s) => {
              const Icon = ICONS[s.icon] ?? Pizza;
              return (
                <StaggerItem key={s.label}>
                  <button
                    onClick={() =>
                      s.prompt.endsWith(" ") ? setInput(s.prompt) : send(s.prompt)
                    }
                    className="flex items-center gap-2 rounded-[22px] bg-chip px-4 py-2.5 text-[13px] font-medium text-chip-ink transition-colors hover:bg-[#dcd2c8]"
                  >
                    <Icon size={15} className="text-chip-ink" />
                    {s.label}
                  </button>
                </StaggerItem>
              );
            })}
          </Stagger>

          {usual && (
            <FadeIn delay={0.35} className="mt-5 w-full max-w-md">
              <Link
                href={`/food/order/${usual.dishId}?platform=${usual.platform}`}
                className="flex items-center gap-2.5 rounded-[22px] bg-chip px-4 py-2.5 text-left transition-colors hover:bg-[#dcd2c8]"
              >
                <RotateCcw size={15} className="shrink-0 text-chip-ink" />
                <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-chip-ink">
                  {t("chat.yourUsual")} {usual.name}
                </span>
                <span className="shrink-0 text-[13px] font-semibold text-terracotta">
                  {rupees(usual.effectivePaise)}
                </span>
              </Link>
            </FadeIn>
          )}
        </div>
      ) : (
        <div className="flex-1 space-y-4 overflow-y-auto py-6">
          {messages.map((m) => (
            <div
              key={m.id}
              className={cn("flex", m.role === "user" ? "justify-end" : "justify-start")}
            >
              {m.role === "user" ? (
                <p className="max-w-[80%] rounded-2xl rounded-br-md bg-cocoa px-4 py-2.5 text-[14px] text-white">
                  {m.content}
                </p>
              ) : (
                <div className="w-full max-w-[95%]">
                  <p className="text-[14px] leading-relaxed text-ink">{m.content}</p>
                  {m.recommendation?.type === "food" && (
                    <div className="mt-3">
                      <FoodRecommendation rec={m.recommendation} />
                    </div>
                  )}
                  {m.recommendation?.type === "ride" && (
                    <div className="mt-3">
                      <RideRecommendation rec={m.recommendation} />
                    </div>
                  )}
                  {m.recommendation?.type === "shop" && (
                    <div className="mt-3">
                      <ShopRecommendation rec={m.recommendation} />
                    </div>
                  )}
                  {m.recommendation?.type === "combo" && (
                    <div className="mt-3">
                      <ComboRecommendation rec={m.recommendation} />
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
          {thinking && <ThinkingSteps />}
          <div ref={bottomRef} />
        </div>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
        className="sticky bottom-0 z-10 pb-4 pt-2"
      >
        {/* Ask bar — matches Figma: white, soft border, plus left, terracotta send */}
        <div className="flex items-center gap-2.5 rounded-[30px] border border-[#d0c8c0] bg-white py-2 pl-4 pr-2 shadow-[0px_3px_8px_rgba(0,0,0,0.07)] lg:py-3 lg:pl-6">
          <Plus size={19} className="shrink-0 text-cocoa/70 lg:hidden" />
          <SearchIcon size={20} className="hidden shrink-0 text-ink lg:block" />
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={t("chat.placeholder")}
            maxLength={500}
            className="h-9 min-w-0 flex-1 bg-transparent text-[15px] text-ink outline-none placeholder:text-[#a09890]"
          />
          <VoiceButton onTranscript={setInput} onFinal={send} />
          <button
            type="submit"
            disabled={!input.trim() || thinking}
            aria-label="Send"
            className="flex size-[38px] shrink-0 items-center justify-center rounded-full bg-send text-white transition-colors hover:bg-[#dc9450] disabled:opacity-40 lg:size-[42px] lg:bg-ink lg:hover:bg-ink/85"
          >
            <Send size={16} />
          </button>
        </div>
      </form>
    </div>
  );
}
