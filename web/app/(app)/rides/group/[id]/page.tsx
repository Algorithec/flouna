"use client";

import { use, useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Users, Copy, Check, ChevronLeft, MapPin, Send, Car } from "lucide-react";
import { api } from "@/lib/api";
import { rupees } from "@/lib/money";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import type { GroupCart, GroupShare } from "@/components/food/GroupCartTypes";

const REFRESH_MS = 5000;

// Shared ride: one trip, the fare splits equally across everyone who joined.
// The host books and pays in-app; friends settle their share via UPI links.
export default function GroupRidePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const [cart, setCart] = useState<GroupCart | null>(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [hostUpi, setHostUpi] = useState("");
  const [shares, setShares] = useState<GroupShare[] | null>(null);
  const [orderId, setOrderId] = useState<string | null>(null);

  const load = useCallback(() => {
    api<GroupCart>(`/api/groups/${id}`)
      .then(setCart)
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load"));
  }, [id]);

  // Poll so everyone sees riders joining (and the booked state) live.
  useEffect(() => {
    load();
    const t = setInterval(load, REFRESH_MS);
    return () => clearInterval(t);
  }, [load]);

  async function copyCode() {
    if (!cart) return;
    try {
      await navigator.clipboard.writeText(cart.code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable — code is visible to copy manually */
    }
  }

  async function shareCode() {
    if (!cart?.ride) return;
    const text = `Share my ${cart.ride.displayName} to ${cart.ride.drop} on Radiues! Join with code ${cart.code} — we split the fare.`;
    if (navigator.share) {
      try {
        await navigator.share({ text });
      } catch {
        /* user dismissed */
      }
    } else {
      await copyCode();
    }
  }

  async function bookRide() {
    setBusy(true);
    setError("");
    try {
      const d = await api<{ orderId: string; shares: GroupShare[] }>(
        `/api/groups/${id}/checkout`,
        { method: "POST", json: hostUpi ? { hostUpiId: hostUpi.trim() } : {} },
      );
      setShares(d.shares);
      setOrderId(d.orderId);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not book the ride");
    } finally {
      setBusy(false);
    }
  }

  if (!cart) {
    return (
      <div className="mx-auto max-w-xl px-4 py-10">
        <p className="text-[14px] text-cocoa">{error || "Loading…"}</p>
      </div>
    );
  }

  const seatsLeft = cart.ride ? cart.ride.seats - cart.members.length : 0;
  const booked = cart.status === "ordered";

  return (
    <div className="mx-auto w-full max-w-xl px-4 py-6 lg:px-6">
      <button
        onClick={() => router.push("/rides")}
        className="flex items-center gap-1 text-[13px] font-medium text-cocoa hover:text-ink"
      >
        <ChevronLeft size={16} /> Rides
      </button>

      <h1 className="mt-3 flex items-center gap-2 text-[20px] font-bold text-ink">
        <Users size={20} className="text-accent" /> Shared ride
      </h1>

      {/* Trip summary */}
      {cart.ride && (
        <Card className="mt-4">
          <p className="flex items-center gap-2 text-[14px] font-bold text-ink">
            <Car size={15} className="text-accent" /> {cart.ride.displayName}
          </p>
          <p className="mt-1.5 flex items-center gap-1.5 text-[13px] text-cocoa">
            <MapPin size={13} className="shrink-0 text-accent" />
            <span className="truncate">
              {cart.ride.pickup} → {cart.ride.drop}
            </span>
          </p>
          <div className="mt-3 flex items-end justify-between">
            <div>
              <p className="text-[12px] text-cocoa">Fare (est.)</p>
              <p className="text-[18px] font-bold text-ink">{rupees(cart.totalPaise)}</p>
            </div>
            <div className="text-right">
              <p className="text-[12px] text-cocoa">Your share</p>
              <p className="text-[18px] font-bold text-accent">
                {rupees(cart.equalSplitPaise)}
              </p>
            </div>
          </div>
        </Card>
      )}

      {/* Join code — only while open and seats remain */}
      {!booked && (
        <Card className="mt-4">
          <p className="text-[13px] font-bold text-ink">
            Invite friends — fare splits equally
          </p>
          <div className="mt-2 flex items-center gap-2">
            <span className="flex-1 rounded-card bg-beige/60 px-4 py-2.5 text-center font-mono text-[22px] font-bold tracking-[6px] text-ink">
              {cart.code}
            </span>
            <button
              onClick={copyCode}
              aria-label="Copy code"
              className="rounded-card border border-line p-3 text-cocoa hover:bg-beige/40"
            >
              {copied ? <Check size={17} className="text-success" /> : <Copy size={17} />}
            </button>
            <button
              onClick={shareCode}
              aria-label="Share code"
              className="rounded-card border border-line p-3 text-cocoa hover:bg-beige/40"
            >
              <Send size={17} />
            </button>
          </div>
          <p className="mt-2 text-[12px] text-cocoa">
            {seatsLeft > 0
              ? `${seatsLeft} seat${seatsLeft === 1 ? "" : "s"} left · friends join from Rides → Join a shared ride`
            : "The ride is full — book when you're ready."}
          </p>
        </Card>
      )}

      {/* Riders */}
      <h2 className="mt-6 text-[14px] font-bold text-ink">
        Riders ({cart.members.length}
        {cart.ride ? `/${cart.ride.seats}` : ""})
      </h2>
      <Card className="mt-2 p-0">
        {cart.members.map((m, i) => (
          <div
            key={m.userId}
            className={`flex items-center justify-between px-4 py-3 ${
              i < cart.members.length - 1 ? "border-b border-line/70" : ""
            }`}
          >
            <p className="text-[14px] text-ink">
              {m.name}
              {m.isYou && <span className="ml-1.5 text-[12px] text-accent">(you)</span>}
            </p>
            <p className="text-[13px] font-semibold text-cocoa">
              {rupees(m.subtotalPaise)}
            </p>
          </div>
        ))}
      </Card>

      {error && <p className="mt-3 text-[13px] text-danger">{error}</p>}

      {/* Booked: shares view (host gets links right after checkout; members see status) */}
      {(booked || shares) && (
        <Card className="mt-5 border-success/40 bg-success/5">
          <p className="text-[14px] font-bold text-ink">Ride booked 🎉</p>
          {shares ? (
            <>
              <p className="mt-1 text-[12px] text-cocoa">
                You paid the full fare. Share these links so everyone settles their part:
              </p>
              <div className="mt-2 flex flex-col gap-1.5">
                {shares
                  .filter((s) => !s.isHost)
                  .map((s) => (
                    <div key={s.userId} className="flex items-center justify-between">
                      <p className="text-[13px] text-ink">
                        {s.name} — {rupees(s.sharePaise)}
                      </p>
                      {s.upiLink && (
                        <a
                          href={s.upiLink}
                          className="text-[12px] font-semibold text-accent hover:underline"
                        >
                          Collect via UPI
                        </a>
                      )}
                    </div>
                  ))}
              </div>
            </>
          ) : (
            <p className="mt-1 text-[12px] text-cocoa">
              Your share is {rupees(cart.equalSplitPaise)} — the host collects it via UPI.
            </p>
          )}
          {(orderId ?? cart.orderId) && cart.isHost && (
            <Button
              onClick={() => router.push(`/pay/${orderId ?? cart.orderId}`)}
              className="mt-3 w-full"
            >
              {shares ? "Pay the fare now" : "Go to payment"}
            </Button>
          )}
        </Card>
      )}

      {/* Host: book */}
      {!booked && !shares && cart.isHost && (
        <div className="mt-5">
          <Input
            label="Your UPI ID (to collect shares — optional)"
            placeholder="name@bank"
            value={hostUpi}
            onChange={(e) => setHostUpi(e.target.value)}
          />
          <Button onClick={bookRide} disabled={busy} className="mt-3 w-full">
            {busy
              ? "Booking…"
              : `Book ${cart.ride?.displayName ?? "ride"} · ${rupees(cart.totalPaise)}`}
          </Button>
          <p className="mt-2 text-center text-[11px] text-cocoa/70">
            You pay in-app now; friends repay their share via UPI.
          </p>
        </div>
      )}

      {!booked && !cart.isHost && (
        <p className="mt-5 text-center text-[13px] text-cocoa">
          Waiting for the host to book — your share updates as riders join.
        </p>
      )}
    </div>
  );
}
