"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Ghost,
  MapPin,
  Pizza,
  Send,
  RotateCcw,
  ShoppingBag,
  Car,
  Utensils,
  Coffee,
  Moon,
  Search as SearchIcon,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import { api } from "@/lib/api";
import { InlinePayment } from "@/components/chat/inline/InlinePayment";
import { OndcSellers } from "@/components/chat/OndcSellers";
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
import { useTheme } from "@/components/theme/ThemeContext";
import { LANGUAGES, type Lang, type TranslationKey } from "@/lib/i18n/dictionaries";
import { notifyCartChanged } from "@/lib/cart";
import { ActionResult } from "@/components/chat/ActionResult";
import { RIDE_COMMAND_EVENT } from "@/components/chat/inline/InlineRideBooking";
import { FadeIn, Stagger, StaggerItem } from "@/components/ui/motion";
import { type TILE_THEMES } from "@/components/ui/CategoryTile";
import type { ChatMessage, FoodQuote } from "@/components/chat/types";
import { cn } from "@/lib/cn";
import { useTemporaryChat } from "@/components/chat/TemporaryChatContext";

type Usual = FoodQuote & { timesOrdered: number };

// Server-built personalized chips. `icon`/`theme` are string keys we map to
// real components/themes here (they can't cross the JSON boundary).
type Suggestion = {
  label: string;
  // The label as a code for the reader's language (`chip.<code>`).
  code?: { code: string; params?: Record<string, string> };
  prompt: string;
  icon: string;
  theme: keyof typeof TILE_THEMES;
  dishId?: string; // set on a reorder chip
};

// A chip's label in the reader's language, or the server's own label for a
// code the app does not know. The prompt a chip sends stays English: the chat
// reads that, and does not yet read dish names written in Indian scripts.
function chipLabel(t: (key: TranslationKey) => string, s: Suggestion): string {
  if (!s.code) return s.label;
  const key = `chip.${s.code.code}` as TranslationKey;
  const said = t(key);
  if (said === key) return s.label;
  return Object.entries(s.code.params ?? {}).reduce((text, [k, v]) => text.replaceAll(`{${k}}`, v), said);
}

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
  { label: "Order pizza", code: { code: "pizza" }, prompt: "Order a pizza under ₹300", icon: "pizza", theme: "orange" },
  { label: "Book a ride", code: { code: "ride" }, prompt: "Book a ride to ", icon: "mapPin", theme: "blue" },
  { label: "Shop a laptop", code: { code: "laptop" }, prompt: "Find me a gaming laptop under ₹70000", icon: "shoppingBag", theme: "purple" },
];

// Does this ask actually involve comparing options? Greetings, thanks and
// small talk don't — claiming to "compare across providers" for "hello" is
// theatre. Deliberately broad: anything that isn't obviously small talk gets
// the full trace, so a real request never under-reports the work.
const SMALL_TALK =
  /^(hi|hey|hello|yo|hola|namaste|thanks|thank you|thx|ok|okay|cool|nice|good (morning|afternoon|evening|night)|bye|who are you|what can you do|help)\b[\s!.?]*$/i;

function needsComparison(message: string): boolean {
  return message.trim() !== "" && !SMALL_TALK.test(message.trim());
}

export default function ChatHomePage() {
  return (
    <Suspense fallback={null}>
      <ChatHome />
    </Suspense>
  );
}

function ChatHome() {
  const { t, setLang } = useI18n();
  const { setTheme } = useTheme();
  const router = useRouter();
  const chatParam = useSearchParams().get("chat");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sessionId, setSessionId] = useState<string | undefined>();
  const [thinking, setThinking] = useState(false);
  // The message currently being answered — decides whether the thinking trace
  // shows the full comparison steps or a plain "Thinking…".
  const [lastAsk, setLastAsk] = useState("");
  // Temporary chat: nothing is persisted server-side and the thread lives only
  // in this component's state.
  const { temporary, resetToken } = useTemporaryChat();
  // Orders placed from inside the conversation, keyed by the message whose
  // card placed them. Keeping it per message rather than as one "current
  // order" means a thread with two bookings in it still shows each payment
  // under the thing it belongs to.
  const [ordered, setOrdered] = useState<Record<string, string>>({});
  const [usual, setUsual] = useState<Usual | null>(null);
  const [suggestions, setSuggestions] = useState<Suggestion[]>(FALLBACK_SUGGESTIONS);

  // Switching in or out of temporary mode starts a fresh conversation either
  // way. Carrying a saved thread into a private one, or the reverse, would do
  // the opposite of what the switch promises.
  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    setMessages([]);
    setSessionId(undefined);
    if (temporary) router.replace("/home", { scroll: false });
  }, [resetToken, temporary, router]);

  useEffect(() => {
    // Incognito asks for none of it. Both of these read order history to build
    // something personal — the usual reorder, the suggested prompts — and the
    // notice on this screen promises that history is not used here. Fetching it
    // anyway and merely declining to draw it would make the promise about
    // storage rather than about use, which is not what it says.
    if (temporary) {
      setUsual(null);
      setSuggestions(FALLBACK_SUGGESTIONS);
      return;
    }
    api<{ usual: Usual | null }>("/api/users/usual")
      .then((d) => setUsual(d.usual))
      .catch(() => setUsual(null));
    api<{ suggestions: Suggestion[] }>("/api/users/suggestions")
      .then((d) => d.suggestions.length > 0 && setSuggestions(d.suggestions))
      .catch(() => {
        /* keep fallbacks */
      });
  }, [temporary]);

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

  // Staying at the bottom while an answer is still arriving.
  //
  // Scrolling once when the message list changes was not enough: a result card
  // carries a map, images and quotes that all land after it mounts, so the
  // scroll reached the bottom as it was and the card then grew past it. The
  // effect had run, the page looked stuck, and the answer was off screen.
  //
  // So the thread is watched for size changes rather than for new messages,
  // and follows them down. It stops following the moment somebody scrolls up,
  // because yanking a reader back to the bottom mid-sentence is worse than not
  // scrolling at all, and it resumes when they return to the end themselves.
  const threadRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    const el = threadRef.current;
    if (!el) return;

    const atBottom = () => el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    const follow = () => {
      if (stick.current) el.scrollTop = el.scrollHeight;
    };

    const onScroll = () => {
      stick.current = atBottom();
    };
    el.addEventListener("scroll", onScroll, { passive: true });

    // Fires as the card grows, which is the part scrollIntoView kept missing.
    const ro = new ResizeObserver(follow);
    for (const child of Array.from(el.children)) ro.observe(child);
    // And as children are added, so a new message is observed too.
    const mo = new MutationObserver(() => {
      for (const child of Array.from(el.children)) ro.observe(child);
      follow();
    });
    mo.observe(el, { childList: true });

    return () => {
      el.removeEventListener("scroll", onScroll);
      ro.disconnect();
      mo.disconnect();
    };
  }, []);

  // A new question is always followed, whatever the reader was doing: they
  // just asked it, so they want to see the answer.
  useEffect(() => {
    stick.current = true;
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, thinking]);

  async function send(text: string) {
    const message = text.trim();
    if (!message || thinking) return;
    setInput("");
    setMessages((m) => [
      ...m,
      {
        id: `u-${Date.now()}`,
        role: "user",
        content: message,
        // Stamped here rather than read back from the server: the bubble is on
        // screen before any reply exists, and a time that appears late reads
        // as the message having been sent late.
        at: new Date().toISOString(),
      },
    ]);
    setLastAsk(message);
    setThinking(true);
    try {
      const d = await api<{ sessionId: string | null; message: ChatMessage }>(
        "/api/chat/message",
        {
          method: "POST",
          json: temporary
            ? { message, temporary: true }
            : { message, sessionId },
        },
      );
      setMessages((m) => [...m, d.message]);
      // What chat did that this device has to carry out. Only for a reply
      // that has just arrived: reopening an old chat must not switch the
      // language back or navigate anywhere.
      for (const e of d.message.action?.effects ?? []) {
        if (e.type === "cart_changed") notifyCartChanged();
        else if (e.type === "language" && LANGUAGES.some((l) => l.code === e.value)) setLang(e.value as Lang);
        else if (e.type === "theme") setTheme(e.value);
        else if (e.type === "navigate" && e.path.startsWith("/")) router.push(e.path);
        else if (e.type === "ride_command") window.dispatchEvent(new CustomEvent(RIDE_COMMAND_EVENT, { detail: e }));
      }
      // A temporary chat has no server session and must never touch the URL —
      // a ?chat= param would make it restorable, which is the whole point of
      // temporary.
      if (!temporary && d.sessionId) {
        setSessionId(d.sessionId);
        if (!sessionId) {
          // Keep the URL in sync so the sidebar highlights this chat and
          // refresh/share restores the conversation.
          setPrevChat(d.sessionId);
          router.replace(`/home?chat=${d.sessionId}`, { scroll: false });
        }
      }
    } catch (err) {
      setMessages((m) => [
        ...m,
        {
          id: `e-${Date.now()}`,
          role: "assistant",
          content:
            err instanceof Error ? err.message : t("hm.error"),
        },
      ]);
    } finally {
      setThinking(false);
    }
  }

  const empty = messages.length === 0;
  // A reorder chip for the usual dish would offer it twice: the usual shortcut
  // below the chips does the same, and shows the price.
  const chips = suggestions.filter((s) => !usual || s.dishId !== usual.dishId).slice(0, 3);

  return (
    <div
      className={cn(
        // No width here: each branch sets its own, so the panel's inset is not
        // fighting a w-full left behind in the shared classes.
        "mx-auto flex max-w-2xl flex-col",
        empty ? "lg:max-w-3xl" : "lg:max-w-5xl",
        // The two layouts are written as alternatives rather than one on top of
        // the other. cn is a plain string join with no conflict resolution, so
        // stacking a second height or width on the first leaves which one wins
        // to the order Tailwind happens to emit them in — it worked, by luck.
        temporary
          ? // Incognito is a mode you can end up in without meaning to, so it
            // has to be readable from the shape of the screen rather than from
            // a line of text somebody has to notice. The conversation sits in
            // its own panel, inset far enough on every side that the page shows
            // around it: the gutter is what makes a frame read as a frame.
            "my-3 h-[calc(100dvh-5.5rem)] w-[calc(100%-1.5rem)] rounded-[20px] border border-line bg-card px-3.5 shadow-card lg:my-4 lg:h-[calc(100dvh-2rem)] lg:px-5"
          : // 4rem = the mobile app header; desktop has none.
            "h-[calc(100dvh-4rem)] w-full px-4 lg:h-dvh lg:px-6",
      )}
    >
      {empty && temporary ? (
        // Incognito has its own empty screen rather than the ordinary one with
        // the personal parts removed. Everything the normal screen offers is
        // built from history: the reorder shortcut, the suggested prompts, the
        // proactive banner. Showing that under a notice saying history is not
        // used here would contradict the notice on the same screen.
        <div className="flex flex-1 flex-col items-center justify-center px-2 text-center">
          <FadeIn y={10} className="flex flex-col items-center">
            <span className="flex size-14 items-center justify-center rounded-full bg-accent-soft">
              <Ghost size={26} className="text-accent" />
            </span>
            <h1 className="mt-4 text-balance text-[26px] font-bold leading-tight tracking-tight text-ink lg:text-[34px]">
              {t("chat.incognitoTitle")}
            </h1>
            <p className="mt-2 text-[15px] text-cocoa">{t("chat.incognitoAsk")}</p>
          </FadeIn>
        </div>
      ) : empty ? (
        <div className="flex flex-1 flex-col items-center justify-center px-2 text-center">
          {/* Proactive heads-up — the engine getting ahead of the user (rain
              near their usual ride, etc.). Renders nothing when quiet. */}
          <div className="mb-6 w-full max-w-md">
            <PredictionBanner
              onBook={(drop) => setInput(`Book a ride to ${drop}`)}
            />
          </div>

          {/* Hero heading — two lines, two colours (Figma 2177:4763: navy then
              terracotta). */}
          <FadeIn y={10}>
            {/* Scales with the screen, and a word too long for it may wrap:
                Telugu's ఎంచుకోవాలనుకుంటున్నారు alone was wider than a 360px phone. */}
            <h1 className="text-balance text-[clamp(22px,7.5vw,30px)] font-bold leading-[1.2] tracking-tight [overflow-wrap:anywhere] lg:text-[44px]">
              <span className="text-navy">{t("chat.heading1")}</span>
              <span className="text-terracotta">{t("chat.heading2")}</span>
            </h1>
          </FadeIn>

          {/* Quick chips — flat, as drawn (Figma 2177:4763). Two per row on
              mobile. */}
          <Stagger delayChildren={0.15} className="mt-6 flex flex-wrap items-center justify-center gap-3">
            {chips.map((s) => {
              const Icon = ICONS[s.icon] ?? Pizza;
              return (
                <StaggerItem key={s.label}>
                  <button
                    onClick={() =>
                      s.prompt.endsWith(" ") ? setInput(s.prompt) : send(s.prompt)
                    }
                    className="flex items-center gap-2 rounded-pill bg-chip px-5 py-3 text-[15px] font-medium text-chip-ink transition-colors hover:opacity-90"
                  >
                    <Icon size={16} className="text-chip-ink" />
                    {chipLabel(t, s)}
                  </button>
                </StaggerItem>
              );
            })}
          </Stagger>

          {usual && (
            <FadeIn delay={0.35} className="mt-5 w-full max-w-md">
              <Link
                href={`/food/order/${usual.dishId}?platform=${usual.platform}`}
                // Outlined rather than solid: the accent chips above are the
                // primary suggestions, and a second solid pill would compete
                // with them instead of reading as the quieter shortcut it is.
                className="flex items-center gap-2.5 rounded-pill border border-line bg-card px-4 py-3 text-left shadow-soft transition-colors hover:bg-beige/40"
              >
                <RotateCcw size={16} className="shrink-0 text-accent" />
                <span className="line-clamp-2 min-w-0 flex-1 text-[14px] font-medium text-ink">
                  {t("chat.yourUsual")} {usual.name}
                </span>
                <span className="shrink-0 text-[14px] font-bold text-accent">
                  {rupees(usual.effectivePaise)}
                </span>
              </Link>
            </FadeIn>
          )}
        </div>
      ) : (
        <div ref={threadRef} className="flex-1 space-y-4 overflow-y-auto py-6">
          {messages.map((m, i) => (
            <div
              key={m.id}
              className={cn("flex", m.role === "user" ? "justify-end" : "justify-start")}
            >
              {m.role === "user" ? (
                <div className="flex max-w-[80%] flex-col items-end">
                  {/* Tinted rather than solid, as in the design: the question
                      is the quieter half of the exchange and a heavy dark
                      block pulls the eye away from the answer under it. */}
                  <p className="rounded-2xl rounded-br-md border border-accent/25 bg-accent-soft px-4 py-2.5 text-[14px] text-ink">
                    {m.content}
                  </p>
                  {m.at && (
                    <span className="mt-1 pr-1 text-[11px] text-cocoa/70">
                      {new Date(m.at).toLocaleTimeString("en-IN", {
                        hour: "numeric",
                        minute: "2-digit",
                      })}
                    </span>
                  )}
                </div>
              ) : (
                <div
                  className={cn(
                    "w-full max-w-[95%]",
                    // An answer that carries a recommendation is a result, and
                    // the design gives a result its own surface: the reasoning,
                    // the evidence and the options read as one thing rather
                    // than as loose text with cards drifting under it. A plain
                    // reply stays plain, because a card around "sure, what
                    // would you like?" is just furniture.
                    m.recommendation &&
                      "rounded-card border border-line bg-card p-3.5 shadow-soft",
                  )}
                >
                  <p className="text-[14px] leading-relaxed text-ink">{m.content}</p>
                  {m.action && (
                    <ActionResult action={m.action} onReply={send} live={i === messages.length - 1 && !thinking} />
                  )}
                  {m.recommendation?.type === "food" && (
                    <div className="mt-3">
                      <FoodRecommendation rec={m.recommendation} compact />
                    </div>
                  )}
                  {m.recommendation?.type === "food" && m.recommendation.ondc && <OndcSellers ondc={m.recommendation.ondc} />}
                  {m.recommendation?.type === "ride" && (
                    <div className="mt-3">
                      <RideRecommendation
                        rec={m.recommendation}
                        chatSessionId={temporary ? null : sessionId}
                        cardKey={m.id}
                        compact
                        onBook={(orderId) =>
                          setOrdered((o) => ({ ...o, [m.id]: orderId }))
                        }
                      />
                    </div>
                  )}

                  {/* Payment, in the thread, under the card that booked it.
                      The journey used to end at a link out to /pay, which is
                      the point at which a conversation stops being one. */}
                  {ordered[m.id] && (
                    <div className="mt-3">
                      <InlinePayment orderId={ordered[m.id]!} />
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
                  {m.recommendation && (
                    <>
                      <Link
                        href={`/results?chat=${sessionId}&msg=${m.id}`}
                        className="mt-2 flex items-center justify-center gap-1.5 rounded-pill border border-accent/40 bg-accent-soft/30 px-4 py-2.5 text-[13px] font-semibold text-accent-ink transition-colors hover:bg-accent-soft/60"
                      >
                        <Sparkles size={13} />
                        {t("hm.viewFull")}
                      </Link>
                    </>
                  )}
                </div>
              )}
            </div>
          ))}
          {thinking && <ThinkingSteps simple={!needsComparison(lastAsk)} />}
        </div>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
        className="sticky bottom-0 z-10 pb-4 pt-2"
      >
        {/* Ask bar — the redesign lifts the send button out of the field into
            its own accent circle beside it (Figma 2177:4763). */}
        <div className="flex items-center gap-3">
          {/* bg-card, not a hardcoded white: the text inside is text-ink, which
              flips to near-white in dark mode. Against a fixed white pill that
              left what you typed at 1.13:1 contrast — invisible. */}
          <div
            className={cn(
              "flex min-w-0 flex-1 items-center gap-2.5 rounded-pill bg-card py-3 pl-5 pr-4",
              // The incognito panel is bg-card too, so the field's shadow has
              // nothing to lift it off and the two surfaces merge into one flat
              // area with a cursor floating in it. Inside the panel the field
              // earns its edge from a border instead.
              temporary ? "border border-line" : "shadow-card",
            )}
          >
            <SearchIcon size={19} className="shrink-0 text-ink/70" />
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={t("chat.placeholder")}
              maxLength={500}
              className="h-9 min-w-0 flex-1 bg-transparent text-[16px] text-ink outline-none placeholder:text-muted"
            />
            <VoiceButton onTranscript={setInput} onFinal={send} />
          </div>
          <button
            type="submit"
            disabled={!input.trim() || thinking}
            aria-label={t("common.send")}
            className="flex size-[54px] shrink-0 items-center justify-center rounded-full bg-send text-white transition-colors hover:opacity-90 disabled:opacity-40"
          >
            <Send size={20} />
          </button>
        </div>
      </form>

    </div>
  );
}
