"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import {
  ArrowLeft,
  Phone,
  ShieldCheck,
  Send,
  BadgeCheck,
  Clock3,
  Info,
} from "lucide-react";
import { api } from "@/lib/api";
import { cn } from "@/lib/cn";
import { useBackTo } from "@/lib/navHistory";

type Message = {
  id: string;
  sender: "rider" | "driver";
  body: string;
  simulated: boolean;
  createdAt: string;
};

type Driver = {
  name: string;
  phoneMasked: string;
  rating: number;
  vehicle: { model: string; plate: string; color: string };
} | null;

/**
 * Talking to the driver of a ride.
 *
 * The Chat button on the tracking screen was an anchor to "sms:" with its
 * default prevented, which is to say a button that did nothing. This is the
 * screen it should have opened.
 *
 * While no live driver network is connected the driver's replies come from the
 * same simulation that invents their name and plate, and the screen says so
 * rather than letting a rider believe somebody is typing.
 */
export default function DriverChatPage() {
  const { id } = useParams<{ id: string }>();
  const back = useBackTo(`/orders/${id}`);

  const [messages, setMessages] = useState<Message[]>([]);
  const [driver, setDriver] = useState<Driver>(null);
  const [eta, setEta] = useState<number | null>(null);
  const [otp, setOtp] = useState<string | null>(null);
  const [route, setRoute] = useState<{ pickup: string; drop: string } | null>(null);
  const [simulated, setSimulated] = useState(false);
  const [ended, setEnded] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [loaded, setLoaded] = useState(false);
  // A ride waiting for payment is not booked: nobody is looking for a captain
  // and the server refuses messages for it. The screen used to say "Finding
  // your captain" over a working message box whose every message failed.
  const [unpaid, setUnpaid] = useState(false);

  const threadRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async (): Promise<{ ended: boolean } | null> => {
    const order = await api<{
      order: { status: string; details: string | { pickup?: string; drop?: string } };
    }>(`/api/orders/${id}`).catch(() => null);
    const awaitingPayment = order
      ? ["created", "pending_payment"].includes(order.order.status)
      : false;
    setUnpaid(awaitingPayment);
    const [chat, track] = await Promise.all([
      awaitingPayment
        ? null
        : api<{ messages: Message[]; simulated: boolean }>(
        `/api/orders/${id}/messages`,
          ).catch(() => null),
      awaitingPayment
        ? null
        : api<{
            tracking: {
              otp: string;
              driver: Driver;
              pickupEtaMinutes: number;
              state: string;
            };
          }>(`/api/orders/${id}/track`).catch(() => null),
    ]);
    if (chat) {
      setMessages(chat.messages);
      setSimulated(chat.simulated);
    }
    if (track) {
      setDriver(track.tracking.driver);
      setOtp(track.tracking.otp);
      setEta(track.tracking.pickupEtaMinutes);
      setEnded(["completed", "cancelled"].includes(track.tracking.state));
    }
    if (order) {
      setEnded((e) => e || ["completed", "cancelled"].includes(order.order.status));
      // The order endpoint hands `details` back already parsed, while some
      // other callers still see the raw column. Take either, rather than
      // throwing into a catch and quietly losing the route bar.
      const raw = order.order.details;
      let d: { pickup?: string; drop?: string } = {};
      try {
        d = typeof raw === "string" ? JSON.parse(raw) : (raw ?? {});
      } catch {
        /* the header still names the driver without it */
      }
      if (d.pickup && d.drop) setRoute({ pickup: d.pickup, drop: d.drop });
    }
    setLoaded(true);
    const finished =
      (track ? ["completed", "cancelled"].includes(track.tracking.state) : false) ||
      (order ? ["completed", "cancelled"].includes(order.order.status) : false);
    return { ended: finished };
  }, [id]);

  // Read once, then keep reading while the trip is live: the driver's side
  // advances with the ride. It stops once the ride ends, because there is
  // nobody left to hear from and polling a finished ride forever is a bug this
  // codebase has already had once.
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      const next = await load();
      if (cancelled || !next) return;
      if (next.ended) clearInterval(timer);
    };
    void tick();
    const timer = setInterval(() => void tick(), 15000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [load]);

  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  async function send(text: string) {
    const body = text.trim();
    if (!body || sending || ended) return;
    setSending(true);
    setDraft("");
    try {
      const res = await api<{ message: Message }>(`/api/orders/${id}/messages`, {
        method: "POST",
        json: { body },
      });
      setMessages((m) => [...m, res.message]);
    } catch {
      // Give it back rather than losing what they wrote.
      setDraft(body);
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="flex h-[calc(100dvh-4rem)] w-full flex-col">
      {/* Who you are talking to, and how far away they are. */}
      <header className="flex items-center gap-2.5 border-b border-line bg-card px-3 py-2.5">
        <button
          onClick={back}
          className="tap-target -ml-1 rounded-full p-1.5 text-cocoa hover:bg-beige"
          aria-label="Back to the trip"
        >
          <ArrowLeft size={18} />
        </button>
        <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-accent text-[14px] font-bold text-white">
          {(driver?.name ?? "?").slice(0, 1)}
        </span>
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1 truncate text-[14px] font-bold text-ink">
            {driver?.name ?? (unpaid ? "Ride not booked yet" : "Finding your captain")}
            {driver && <BadgeCheck size={13} className="shrink-0 text-success" />}
          </p>
          <p className="truncate text-[11px] text-cocoa">
            {driver
              ? `${driver.vehicle.color} ${driver.vehicle.model} · ${driver.vehicle.plate}`
              : unpaid
                ? "Pay to book it"
                : "Not assigned yet"}
          </p>
        </div>
        {driver && (
          <a
            href={`tel:${driver.phoneMasked.replace(/[^0-9+]/g, "")}`}
            title={driver.phoneMasked}
            aria-label={`Call ${driver.name}`}
            className="tap-target flex size-9 shrink-0 items-center justify-center rounded-full bg-success/15 text-success"
          >
            <Phone size={16} />
          </a>
        )}
      </header>

      {route && (
        <div className="flex items-center justify-between gap-2 border-b border-line bg-accent-soft/40 px-3.5 py-2">
          <p className="min-w-0 truncate text-[11.5px] font-medium text-ink">
            {route.pickup} → {route.drop}
          </p>
          {!ended && eta != null && eta > 0 && (
            <span className="flex shrink-0 items-center gap-1 rounded-pill bg-accent px-2 py-0.5 text-[10.5px] font-bold text-white">
              <Clock3 size={10} />
              {eta} min away
            </span>
          )}
        </div>
      )}

      {simulated && (
        <p className="flex items-start gap-1.5 bg-warning-soft px-3.5 py-2 text-[11.5px] leading-relaxed text-warning">
          <Info size={13} className="mt-0.5 shrink-0" />
          <span>
            Demo ride. No live driver network is connected yet, so these replies
            are simulated and nobody is typing them.
          </span>
        </p>
      )}

      <div
        ref={threadRef}
        className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3.5 py-3"
      >
        {loaded && messages.length === 0 && unpaid && !ended && (
          <div className="mt-8 text-center">
            <p className="text-[13px] text-cocoa">
              This ride is booked once it is paid for. Your captain can message
              you here after that.
            </p>
            <Link
              href={`/pay/${id}`}
              className="tap-target mt-3 inline-flex rounded-pill bg-accent px-5 py-2.5 text-[13px] font-bold text-white"
            >
              Pay to book
            </Link>
          </div>
        )}
        {loaded && messages.length === 0 && (!unpaid || ended) && (
          <p className="mt-8 text-center text-[13px] text-cocoa">
            {ended
              ? "This ride has ended."
              : "Your captain will message you here once the ride is accepted."}
          </p>
        )}
        {messages.map((m) => (
          <Bubble key={m.id} message={m} />
        ))}
      </div>

      {otp && otp !== "----" && !ended && (
        <div className="flex items-center gap-2 border-t border-line bg-card px-3.5 py-2">
          <ShieldCheck size={14} className="shrink-0 text-success" />
          <p className="flex-1 text-[12px] text-cocoa">
            Your OTP
            <span className="ml-1 font-mono text-[15px] font-bold tracking-[0.3em] text-ink">
              {otp}
            </span>
          </p>
          <button
            onClick={() => void send(`My OTP is ${otp}.`)}
            disabled={sending}
            className="tap-target shrink-0 rounded-pill bg-accent px-3 py-1.5 text-[12px] font-bold text-white disabled:opacity-60"
          >
            Share
          </button>
        </div>
      )}

      {!ended && !unpaid && (
        <>
          {/* The things a rider actually says while standing at a kerb, so they
              are one tap instead of one-handed typing. */}
          <div className="no-scrollbar flex gap-1.5 overflow-x-auto border-t border-line bg-card px-3.5 py-2">
            {[
              "I am here",
              "Be there in 2 min",
              "Coming down now",
              "Please wait a minute",
            ].map((q) => (
              <button
                key={q}
                onClick={() => void send(q)}
                disabled={sending}
                className="tap-target shrink-0 rounded-pill border border-accent/40 bg-accent-soft/40 px-3 py-1.5 text-[12px] font-semibold text-accent disabled:opacity-60"
              >
                {q}
              </button>
            ))}
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              void send(draft);
            }}
            className="flex items-center gap-2 border-t border-line bg-card px-3 py-2.5"
          >
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Type a message…"
              maxLength={500}
              className="min-w-0 flex-1 rounded-pill border border-line bg-cream px-3.5 py-2.5 text-[14px] text-ink outline-none placeholder:text-cocoa/60"
            />
            <button
              type="submit"
              disabled={!draft.trim() || sending}
              aria-label="Send"
              className="tap-target flex size-10 shrink-0 items-center justify-center rounded-full bg-accent text-white disabled:opacity-50"
            >
              <Send size={16} />
            </button>
          </form>
        </>
      )}
    </div>
  );
}

function Bubble({ message }: { message: Message }) {
  const mine = message.sender === "rider";
  const at = new Date(message.createdAt).toLocaleTimeString("en-IN", {
    hour: "numeric",
    minute: "2-digit",
  });
  return (
    <div className={cn("flex", mine ? "justify-end" : "justify-start")}>
      <div className="max-w-[78%]">
        <div
          className={cn(
            "rounded-2xl px-3.5 py-2 text-[13.5px] leading-relaxed",
            mine
              ? "rounded-br-md bg-accent text-white"
              : "rounded-bl-md border border-line bg-card text-ink",
          )}
        >
          {message.body}
        </div>
        <p
          className={cn(
            "mt-0.5 text-[10.5px] text-cocoa",
            mine ? "text-right" : "text-left",
          )}
        >
          {at}
        </p>
      </div>
    </div>
  );
}
