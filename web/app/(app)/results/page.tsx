"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, Sparkles, Share2, Check } from "lucide-react";
import { api } from "@/lib/api";
import {
  FoodRecommendation,
  RideRecommendation,
  ShopRecommendation,
  ComboRecommendation,
} from "@/components/chat/RecommendationCards";
import { FadeIn } from "@/components/ui/motion";
import type { ChatMessage, Recommendation } from "@/components/chat/types";

export default function ResultsPage() {
  return (
    <Suspense fallback={null}>
      <Results />
    </Suspense>
  );
}

function Results() {
  const router = useRouter();
  const params = useSearchParams();
  const chatId = params.get("chat");
  const msgId = params.get("msg");

  const [rec, setRec] = useState<Recommendation | null>(null);
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [shared, setShared] = useState(false);

  useEffect(() => {
    if (!chatId || !msgId) return;

    api<{ session: { id: string; messages: ChatMessage[] } }>(
      `/api/chat/sessions/${chatId}`,
    )
      .then((d) => {
        const msg = d.session.messages.find((m) => m.id === msgId);
        if (!msg?.recommendation) {
          setError("Recommendation not found");
        } else {
          setRec(msg.recommendation);
          setContent(msg.content);
        }
      })
      .catch(() => setError("Could not load results"))
      .finally(() => setLoading(false));
  }, [chatId, msgId]);

  if (!chatId || !msgId) {
    return (
      <div className="flex h-[calc(100dvh-4rem)] flex-col items-center justify-center gap-4 px-4 lg:h-dvh">
        <p className="text-[15px] text-cocoa">Missing chat or message ID</p>
        <button
          onClick={() => router.back()}
          className="rounded-pill bg-accent px-5 py-2.5 text-[14px] font-semibold text-white"
        >
          Go back
        </button>
      </div>
    );
  }

  const onShare = async () => {
    const text = `Check out this recommendation on Flouna`;
    try {
      if (navigator.share) await navigator.share({ title: "Flouna Results", text });
      else {
        await navigator.clipboard.writeText(text);
        setShared(true);
        setTimeout(() => setShared(false), 2000);
      }
    } catch {
      /* dismissed */
    }
  };

  if (loading) {
    return (
      <div className="flex h-[calc(100dvh-4rem)] items-center justify-center lg:h-dvh">
        <div className="flex flex-col items-center gap-3">
          <Sparkles size={28} className="animate-pulse text-accent" />
          <p className="text-[14px] text-cocoa">Loading results&hellip;</p>
        </div>
      </div>
    );
  }

  if (error || !rec) {
    return (
      <div className="flex h-[calc(100dvh-4rem)] flex-col items-center justify-center gap-4 px-4 lg:h-dvh">
        <p className="text-[15px] text-cocoa">{error ?? "No results found"}</p>
        <button
          onClick={() => router.back()}
          className="rounded-pill bg-accent px-5 py-2.5 text-[14px] font-semibold text-white"
        >
          Go back
        </button>
      </div>
    );
  }

  return (
    <div className="mx-auto flex h-[calc(100dvh-4rem)] max-w-3xl flex-col px-4 lg:h-dvh lg:max-w-5xl lg:px-6">
      {/* Sticky header with back + share */}
      <div className="sticky top-0 z-10 flex items-center justify-between bg-page py-3">
        <button
          onClick={() => router.back()}
          className="tap-target flex items-center gap-2 text-[14px] font-medium text-ink transition-colors hover:text-accent"
        >
          <ArrowLeft size={18} />
          <span className="hidden sm:inline">Back to chat</span>
        </button>

        <div className="flex items-center gap-2">
          <span className="flex items-center gap-1.5 rounded-full bg-accent-soft px-3 py-1 text-[11px] font-bold tracking-wide text-accent">
            <Sparkles size={12} />
            {rec.type === "combo" ? "FOOD + RIDE" : rec.type.toUpperCase()} RESULTS
          </span>
          <button
            onClick={onShare}
            className="tap-target flex size-9 items-center justify-center rounded-full border border-line transition-colors hover:bg-beige/50"
            aria-label="Share results"
          >
            {shared ? (
              <Check size={16} className="text-success" />
            ) : (
              <Share2 size={16} className="text-cocoa" />
            )}
          </button>
        </div>
      </div>

      {/* Scrollable results body */}
      <div className="flex-1 overflow-y-auto pb-8">
        <FadeIn y={10} className="flex flex-col gap-4">
          {/* AI reasoning summary */}
          {content && (
            <div className="rounded-card border border-accent/20 bg-accent-soft/30 p-4">
              <p className="flex items-center gap-1.5 text-[11px] font-bold tracking-wide text-accent">
                <Sparkles size={12} /> AI REASONING
              </p>
              <p className="mt-2 text-[14px] leading-relaxed text-ink">
                {content}
              </p>
            </div>
          )}

          {/* Recommendation content */}
          {rec.type === "food" && <FoodRecommendation rec={rec} />}
          {rec.type === "ride" && <RideRecommendation rec={rec} />}
          {rec.type === "shop" && <ShopRecommendation rec={rec} />}
          {rec.type === "combo" && <ComboRecommendation rec={rec} />}
        </FadeIn>
      </div>
    </div>
  );
}
