"use client";

import { useEffect, useRef, useState } from "react";
import { Mic, MicOff } from "lucide-react";
import { cn } from "@/lib/cn";
import { useI18n } from "@/components/i18n/I18nContext";

// Browser-native speech recognition (Chrome/Edge/Android). No API cost.
type SpeechRecognitionLike = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult:
    | ((e: {
        results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>;
      }) => void)
    | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
};

function getRecognizer(): SpeechRecognitionLike | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  };
  const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
  return Ctor ? new Ctor() : null;
}

export function VoiceButton({
  onTranscript,
  onFinal,
}: {
  onTranscript: (text: string) => void;
  onFinal: (text: string) => void;
}) {
  const { speechLang } = useI18n();
  // Lazy initializer runs client-side only (component is "use client"),
  // so feature detection is SSR-safe without an effect.
  const [supported] = useState(() => getRecognizer() !== null);
  const [listening, setListening] = useState(false);
  const recRef = useRef<SpeechRecognitionLike | null>(null);

  useEffect(() => {
    return () => recRef.current?.abort();
  }, []);

  function toggle() {
    if (listening) {
      recRef.current?.stop();
      return;
    }
    const rec = getRecognizer();
    if (!rec) return;
    recRef.current = rec;
    rec.lang = speechLang; // follows the user's chosen language (en/hi/te-IN)
    rec.interimResults = true;
    rec.continuous = false;

    let finalText = "";
    rec.onresult = (e) => {
      let interim = "";
      for (let i = 0; i < e.results.length; i++) {
        const result = e.results[i];
        const transcript = result?.[0]?.transcript ?? "";
        if (result?.isFinal) finalText += transcript;
        else interim += transcript;
      }
      onTranscript(finalText + interim);
    };
    rec.onend = () => {
      setListening(false);
      const text = finalText.trim();
      if (text) onFinal(text);
    };
    rec.onerror = () => setListening(false);

    setListening(true);
    rec.start();
  }

  if (!supported) {
    return (
      <span
        title="Voice input is not supported in this browser"
        className="flex size-10 shrink-0 items-center justify-center rounded-full text-cocoa/30"
      >
        <MicOff size={16} />
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={listening ? "Stop listening" : "Speak your request"}
      className={cn(
        "tap-target relative flex size-10 shrink-0 items-center justify-center rounded-full transition-colors",
        listening
          ? "bg-accent text-white"
          : "text-cocoa hover:bg-beige",
      )}
    >
      {listening && (
        <span className="absolute inset-0 animate-ping rounded-full bg-accent/40" />
      )}
      <Mic size={16} className="relative" />
    </button>
  );
}
