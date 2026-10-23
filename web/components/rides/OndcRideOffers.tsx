"use client";

// Rides from ONDC ride providers between the chosen pickup and drop.
//
// Offered only to riders the server lets in (the same switch and tester list
// as ONDC food). A search goes to every ride provider on the network; their
// offers arrive over the next seconds, so this asks again until the search
// window closes. Booking one opens the ride's own screen. The rides page
// keys this on the pickup and drop, so new places start a fresh search.

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Bike, Car, Loader2, Network } from "lucide-react";
import { api } from "@/lib/api";
import { rupees } from "@/lib/money";
import { useI18n } from "@/components/i18n/I18nContext";
import type { TranslationKey } from "@/lib/i18n/dictionaries";

type Place = { name: string; area: string; lat: number; lng: number };
type Offer = {
  bppId: string;
  appName: string;
  providerId: string;
  providerName?: string;
  itemId: string;
  vehicle: string;
  variant?: string;
  farePaise: number;
  minPaise?: number;
  maxPaise?: number;
};

const POLL_MS = 2500;
const VEHICLE_LABEL: Record<string, TranslationKey> = { AUTO_RICKSHAW: "veh.auto", CAB: "veh.cab", TWO_WHEELER: "veh.bike" };
/** A vehicle type with no wording yet, made readable: "Sedan", not "SEDAN". */
const readable = (v: string) => v.charAt(0) + v.slice(1).toLowerCase().replace(/_/g, " ");

export function OndcRideOffers({ pickup, drop }: { pickup: Place; drop: Place }) {
  const { t } = useI18n();
  const router = useRouter();
  const [available, setAvailable] = useState(false);
  const [rideId, setRideId] = useState<string | null>(null);
  const [offers, setOffers] = useState<Offer[]>([]);
  const [searching, setSearching] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [booking, setBooking] = useState<string | null>(null);

  useEffect(() => {
    api<{ available: boolean }>("/api/ondc/rides/available")
      .then((r) => setAvailable(r.available))
      .catch(() => setAvailable(false));
  }, []);

  useEffect(() => {
    if (!rideId) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const r = await api<{ status: string; offers: Offer[] }>(`/api/ondc/rides/${rideId}/offers`);
        if (!alive) return;
        setOffers(r.offers);
        if (r.status === "searching") timer = setTimeout(poll, POLL_MS);
        else setSearching(false);
      } catch {
        if (alive) setSearching(false);
      }
    };
    void poll();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [rideId]);

  if (!available) return null;

  const place = (p: Place) => ({ lat: p.lat, lng: p.lng, address: p.name, area: p.area || p.name });

  async function search() {
    setSearching(true);
    setFailed(null);
    setOffers([]);
    try {
      const r = await api<{ rideId: string }>("/api/ondc/rides", { method: "POST", json: { pickup: place(pickup), drop: place(drop) } });
      setRideId(r.rideId);
    } catch (err) {
      setSearching(false);
      setFailed(err instanceof Error && err.message ? err.message : t("or.failed"));
    }
  }

  async function book(o: Offer) {
    if (!rideId || booking) return;
    const key = `${o.bppId}|${o.providerId}|${o.itemId}`;
    setBooking(key);
    setFailed(null);
    try {
      await api(`/api/ondc/rides/${rideId}/choose`, { method: "POST", json: { bppId: o.bppId, providerId: o.providerId, itemId: o.itemId } });
      router.push(`/rides/ondc/${rideId}`);
    } catch (err) {
      setBooking(null);
      setFailed(err instanceof Error && err.message ? err.message : t("or.failedAction"));
    }
  }

  return (
    <section className="rounded-card border border-line bg-card p-3">
      <div className="flex items-center gap-2">
        <Network size={15} className="text-accent" />
        <h3 className="text-[13px] font-semibold text-ink">{t("or.title")}</h3>
        {searching && <Loader2 size={13} className="ml-auto animate-spin text-cocoa" />}
      </div>
      {!rideId && (
        <button
          type="button"
          onClick={() => void search()}
          disabled={searching}
          className="tap-target mt-2 inline-flex min-h-10 w-full items-center justify-center rounded-pill border border-btn px-4 py-2 text-[13px] font-semibold text-ink transition-colors hover:bg-beige/60 disabled:opacity-50"
        >
          {searching ? t("or.searching") : t("or.search")}
        </button>
      )}
      {rideId && searching && offers.length === 0 && <p className="mt-2 text-[12px] text-cocoa">{t("or.searching")}</p>}
      {rideId && !searching && offers.length === 0 && (
        <>
          <p className="mt-2 text-[12px] text-cocoa">{t("or.none")}</p>
          {/* Not a dead end: a search that found nothing can be run again. */}
          <button
            type="button"
            onClick={() => void search()}
            className="tap-target mt-2 inline-flex min-h-10 w-full items-center justify-center rounded-pill border border-btn px-4 py-2 text-[13px] font-semibold text-ink transition-colors hover:bg-beige/60"
          >
            {t("or.searchAgain")}
          </button>
        </>
      )}
      {offers.length > 0 && (
        <ul className="mt-2 space-y-2">
          {offers.map((o) => {
            const key = `${o.bppId}|${o.providerId}|${o.itemId}`;
            const Icon = o.vehicle === "TWO_WHEELER" ? Bike : Car;
            const label = VEHICLE_LABEL[o.vehicle];
            return (
              <li key={key} className="flex items-center gap-3 rounded-[12px] border border-line px-3 py-2.5">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-beige">
                  <Icon size={17} className="text-ink" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-semibold text-ink">
                    {label ? t(label) : readable(o.vehicle)}
                    {o.variant ? ` · ${o.variant}` : ""}
                  </span>
                  <span className="block truncate text-[11px] text-cocoa">{t("or.via").replace("{app}", o.providerName ?? o.appName)}</span>
                </span>
                <span className="shrink-0 text-right">
                  <span className="block text-[14px] font-bold text-ink">{rupees(o.farePaise)}</span>
                  {o.minPaise != null && o.maxPaise != null && o.minPaise !== o.maxPaise && (
                    <span className="block text-[10px] text-cocoa">{t("or.range").replace("{min}", rupees(o.minPaise)).replace("{max}", rupees(o.maxPaise))}</span>
                  )}
                </span>
                <button
                  type="button"
                  onClick={() => void book(o)}
                  disabled={booking !== null}
                  className="tap-target shrink-0 rounded-pill bg-btn px-3.5 py-1.5 text-[12px] font-semibold text-white transition-colors hover:bg-btn-hover disabled:bg-btn/50"
                >
                  {booking === key ? <Loader2 size={13} className="animate-spin" /> : t("or.book")}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {failed && <p className="mt-2 text-[12px] text-danger">{failed}</p>}
    </section>
  );
}
