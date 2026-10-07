"use client";

import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/components/i18n/I18nContext";
import dynamic from "next/dynamic";
import { Crosshair, MapPin, Loader2, Search, Sparkles } from "lucide-react";
import { newSearchSession, resolvePlace, searchPlaces, type Suggestion } from "@/lib/places";
import { rupees } from "@/lib/money";
import { cn } from "@/lib/cn";
import { VehicleArt } from "@/components/rides/VehicleArt";
import { RideBestCard, RideOptionRow } from "@/components/rides/RideOptionCard";
import { TripSummary } from "@/components/rides/TripSummary";
import { useRideBooking, VEHICLES, type Vehicle } from "@/lib/rides/useRideBooking";
import { FlounaInsights, cheaperVehicleHack } from "@/components/chat/FlounaInsights";

// Booking a ride without leaving the conversation.
//
// The old card ended at a Select button that pushed you to /rides, where you
// re-stated a destination you had already typed and started the flow again.
// This is that flow, in the thread: a map you can tap, both endpoints, the
// vehicle, live quotes, and confirm.
//
// It runs on the same hook the rides page runs on, so there is exactly one
// booking machine. Anything this card could do differently would be a way for
// the two to disagree about a fare.
//
// The map is deliberately short. It is a step in a conversation, not the
// screen, and a map tall enough to feel like the rides page would push the
// answer and the composer off a phone.

const RideMap = dynamic(
  () => import("@/components/rides/RideMap").then((m) => m.RideMap),
  {
    ssr: false,
    loading: () => <div className="h-[190px] animate-pulse rounded-2xl bg-beige/50" />,
  },
);

const VEHICLE_LABEL: Record<Vehicle, string> = {
  any: "Any",
  bike: "Bike",
  auto: "Auto",
  cab: "Cab",
};

export function InlineRideBooking({
  drop,
  vehicle,
  scheduledAt,
  onBooked,
  showAny = true,
  decisionId,
  fareLimitPaise,
  pickupLimitMinutes,
}: {
  /** Destination the chat already understood, resolved on open. */
  drop?: string | null;
  vehicle?: Vehicle;
  scheduledAt?: string | null;
  /** Handed the new order id so the thread can move on to payment. */
  onBooked: (orderId: string) => void;
  showAny?: boolean;
  /** The ranking behind these quotes, paired with the order on booking. */
  decisionId?: string;
  /**
   * Limits the rider stated in the conversation, applied to the real trip.
   *
   * Chat prices a placeholder distance, so it cannot hold a fare to a stated
   * maximum. This card prices the route the rider actually set, which is the
   * only place the limit can be applied honestly, so it arrives here rather
   * than being dropped after the reply had already mentioned it.
   */
  fareLimitPaise?: number;
  pickupLimitMinutes?: number;
}) {
  const { t } = useI18n();
  const b = useRideBooking({
    initialDrop: drop ?? null,
    initialVehicle: vehicle ?? "any",
    initialScheduledAt: scheduledAt ?? null,
    decisionId,
    maxFarePaise: fareLimitPaise,
    maxPickupMinutes: pickupLimitMinutes,
  });
  const [confirming, setConfirming] = useState(false);
  // Choosing a fare and paying for it used to be the same tap. The summary is
  // the step between: the distance, the time and the total in one place before
  // any money moves.
  const [reviewing, setReviewing] = useState(false);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<Suggestion[]>([]);
  // One search session per pick; replaced once a place is chosen.
  const session = useRef(newSearchSession());
  const [searching, setSearching] = useState(false);
  const seq = useRef(0);

  // Debounced so a four-word destination is one lookup, not four. The sequence
  // number is what stops a slow early request landing after a fast later one
  // and replacing the right answer with a stale one.
  useEffect(() => {
    const q = query.trim();
    // Returns without clearing: results are hidden by deriving them below
    // rather than by writing state during the effect, which React 19 rejects
    // and which would re-render every keystroke of the first two letters.
    if (!b.picking || q.length < 3) return;
    const mine = ++seq.current;
    const id = setTimeout(() => {
      // Moved inside the timer: setting it synchronously would flash the
      // spinner on every keystroke, including ones the debounce discards.
      setSearching(true);
      searchPlaces(q, { session: session.current })
        .then((found) => {
          if (mine !== seq.current) return;
          setHits(found.slice(0, 5));
        })
        .catch(() => mine === seq.current && setHits([]))
        .finally(() => mine === seq.current && setSearching(false));
    }, 350);
    return () => clearTimeout(id);
  }, [query, b.picking]);

  // Stale results from a previous endpoint or a since-shortened query are
  // simply not shown, rather than being cleared out of state on the way past.
  const visibleHits = b.picking && query.trim().length >= 3 ? hits : [];

  async function choose(suggestion: Suggestion) {
    const picking = b.picking;
    setQuery("");
    setHits([]);
    // A Google suggestion has no coordinates until it is chosen.
    const place = await resolvePlace(suggestion, session.current);
    session.current = newSearchSession();
    if (!place) return;
    if (picking === "pickup") b.setPickup(place);
    else b.setDrop(place);
    b.setPicking(null);
  }

  async function confirm() {
    setConfirming(true);
    const id = await b.confirm();
    setConfirming(false);
    if (id) onBooked(id);
  }

  const endpoint = (
    which: "pickup" | "drop",
    place: { name: string; area: string } | null,
  ) => {
    const active = b.picking === which;
    return (
      <button
        type="button"
        onClick={() => b.setPicking(active ? null : which)}
        className={cn(
          "tap-target flex w-full items-center gap-2.5 rounded-xl border px-3 py-2.5 text-left transition-colors",
          active ? "border-accent bg-accent-soft/40" : "border-line bg-card",
        )}
      >
        <span
          className={cn(
            "size-2 shrink-0 rounded-full",
            which === "pickup" ? "bg-success" : "bg-accent",
          )}
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium text-ink">
            {place?.name ?? (which === "pickup" ? t("bill.pickup") : t("ib.whereTo"))}
          </span>
          {place?.area && (
            <span className="block truncate text-[11px] text-cocoa">{place.area}</span>
          )}
        </span>
        {/* Says what tapping the map will now do, rather than leaving the
            person to discover that the map became interactive. */}
        {active && (
          <span className="shrink-0 text-[11px] font-semibold text-accent">
            {t("ib.tapMap")}
          </span>
        )}
      </button>
    );
  };

  if (reviewing && b.selected && b.pickup && b.drop && b.route) {
    return (
      <div className="w-full rounded-card border border-line bg-card p-3.5 shadow-soft">
        <TripSummary
          quote={b.selected}
          pickup={b.pickup.name}
          drop={b.drop.name}
          distanceKm={b.route.distanceKm}
          rideMinutes={b.route.rideMinutes}
          onEditPickup={() => {
            setReviewing(false);
            b.setPicking("pickup");
          }}
          onEditDrop={() => {
            setReviewing(false);
            b.setPicking("drop");
          }}
          onBack={() => setReviewing(false)}
          onConfirm={confirm}
          busy={confirming || b.busy}
        />
      </div>
    );
  }

  return (
    <div className="w-full rounded-card border border-line bg-card p-3.5 shadow-soft">
      <div className="relative overflow-hidden rounded-2xl">
        {/* Tall enough for a route and two named ends. At 190px the
            destination label was pushed off the top edge. */}
        <div className="h-[225px]">
          <RideMap
            pickup={b.mapPoints.pickup}
            drop={b.mapPoints.drop}
            routeGeometry={b.route?.geometry ?? null}
            pickupLabel={b.pickup?.name ?? null}
            dropLabel={b.drop?.name ?? null}
            providers={b.quotes.map((q) => q.provider)}
            onPick={b.picking ? b.pickOnMap : null}
          />
        </div>

        {/* Use my location, on the map where a rider looks for it.
            It was a 15px crosshair inside the pickup row, small enough that a
            script driving this app could not reliably hit it, which is a fair
            warning about a thumb. */}
        <button
          type="button"
          onClick={() => b.detectPickup()}
          disabled={b.locating}
          aria-label={t("ib.useLocation")}
          className="tap-target absolute bottom-2.5 right-2.5 z-10 flex size-10 items-center justify-center rounded-full bg-card text-ink shadow-md transition-transform hover:scale-105 disabled:opacity-60"
        >
          {b.locating ? (
            <Loader2 size={17} className="animate-spin" />
          ) : (
            <Crosshair size={17} />
          )}
        </button>
      </div>

      <div className="mt-3 flex flex-col gap-2">
        {endpoint("pickup", b.pickup)}
        {endpoint("drop", b.drop)}
      </div>

      {/* Typing, for when the map is not the easiest way to say where you are.
          Shown only while an endpoint is being chosen, so it is an answer to a
          question currently being asked rather than a permanent field. */}
      {b.picking && (
        <div className="mt-2">
          <div className="flex items-center gap-2 rounded-xl border border-line bg-cream px-3 py-2.5">
            <Search size={15} className="shrink-0 text-cocoa" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              autoFocus
              placeholder={
                b.picking === "pickup" ? t("ib.searchPickup") : t("ib.searchDrop")
              }
              className="min-w-0 flex-1 bg-transparent text-[14px] text-ink outline-none placeholder:text-cocoa/60"
            />
            {searching && <Loader2 size={14} className="shrink-0 animate-spin text-cocoa" />}
          </div>
          {visibleHits.length > 0 && (
            <ul className="mt-1.5 overflow-hidden rounded-xl border border-line">
              {visibleHits.map((h) => (
                <li key={`${h.name}-${h.lat}-${h.lng}`}>
                  <button
                    type="button"
                    onClick={() => choose(h)}
                    className="tap-target flex w-full items-start gap-2 border-b border-line/70 bg-card px-3 py-2.5 text-left last:border-0 hover:bg-beige/40"
                  >
                    <MapPin size={13} className="mt-0.5 shrink-0 text-accent" />
                    <span className="min-w-0">
                      <span className="block truncate text-[13px] font-medium text-ink">
                        {h.name}
                      </span>
                      <span className="block truncate text-[11px] text-cocoa">{h.area}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Saved places, offered only while an endpoint is being chosen, so they
          are an answer to a question the person is currently being asked. */}
      {b.picking && b.saved.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {b.saved.map((p) => (
            <button
              key={`${p.name}-${p.lat}`}
              type="button"
              onClick={() => choose(p)}
              className="tap-target flex items-center gap-1 rounded-pill border border-line px-2.5 py-1.5 text-[12px] text-cocoa hover:bg-beige/50"
            >
              <MapPin size={11} className="text-accent" />
              {p.name}
            </button>
          ))}
        </div>
      )}

      <div className="mt-3 flex gap-1.5 rounded-pill bg-accent-soft/40 p-1">
        {VEHICLES.filter((v) => showAny || v !== "any").map((v) => (
          <button
            key={v}
            type="button"
            onClick={() => b.setVehicle(v)}
            className={cn(
              "tap-target flex-1 rounded-pill py-1.5 text-[13px] font-semibold capitalize transition-colors",
              b.vehicle === v
                ? "bg-white text-accent shadow-soft"
                : "text-cocoa hover:text-ink",
            )}
          >
            <span className="flex items-center justify-center gap-1.5">
              {v !== "any" && <VehicleArt vehicle={v} className="h-4 w-6 shrink-0" />}
              {VEHICLE_LABEL[v]}
            </span>
          </button>
        ))}
      </div>

      {b.route && (
        <p className="mt-2.5 text-[12px] text-cocoa">
          {t("ib.routeLine")
            .replace("{km}", b.route.distanceKm.toFixed(1))
            .replace("{min}", String(b.route.rideMinutes))}
        </p>
      )}


      {b.quotes.length > 0 && (
        <div className="mt-3 flex flex-col gap-2.5">
          {(() => {
            const vehicleHack = cheaperVehicleHack(b.quotes[0]!, b.quotes);
            return (
              <FlounaInsights
                hacks={[vehicleHack].filter((h): h is NonNullable<typeof h> => h !== null)}
                offers={b.quotes[0]?.offers ?? []}
              />
            );
          })()}

          <div className="flex items-center justify-between gap-2">
            <p className="text-[15px] font-bold text-ink">{t("rc.availableProviders")}</p>
            <span className="flex items-center gap-1 rounded-full bg-accent-soft px-2.5 py-1 text-[11px] font-semibold text-accent">
              <Sparkles size={11} />
              {b.quotes.length === 1
                ? t("rc.oneOptionFound")
                : t("rc.optionsFound").replace("{n}", String(b.quotes.length))}
            </span>
          </div>

          {/* The engine's pick, stated as a pick. A list of near-identical
              prices makes the reader do the comparing again; naming the best
              one and showing what it is bought with is the whole point of
              having compared them. */}
          <RideBestCard
            q={b.quotes[0]!}
            onSelect={() => {
              b.setSelected(b.quotes[0]!);
              setReviewing(true);
            }}
          />

          {b.quotes.length > 1 && (
            <>
              <p className="mt-0.5 text-[14px] font-bold text-ink">
                {t("ib.youllLike")}
              </p>
              {b.quotes.slice(1).map((q) => (
                <RideOptionRow
                  key={`${q.provider}-${q.productName}`}
                  q={q}
                  onSelect={() => {
                    b.setSelected(q);
                    setReviewing(true);
                  }}
                />
              ))}
            </>
          )}
        </div>
      )}

      {/* The rider's own limit left nothing to show. Said plainly, with what
          is actually available, because an empty list with a button reading
          "Getting prices…" claims a request is still running when it has
          already been answered. The limit is not quietly waived: the nearest
          option is named, not offered. */}
      {b.quotes.length === 0 && b.unmetNote && (
        <p role="status" className="mt-3 rounded-2xl bg-beige/60 px-3 py-2.5 text-[12px] text-ink">
          {b.unmetNote}
        </p>
      )}

      {b.error && (
        <p role="alert" className="mt-2.5 text-[12px] text-danger">
          {b.error}
        </p>
      )}

      <button
        type="button"
        onClick={() => (b.selected ? setReviewing(true) : undefined)}
        disabled={!b.ready || confirming || b.busy}
        className="tap-target mt-3 w-full rounded-pill bg-accent px-4 py-3 text-[14px] font-bold text-white transition-opacity disabled:opacity-50"
      >
        {confirming
          ? t("rides.booking")
          : b.selected
            ? t("ib.review")
                .replace("{name}", b.selected.displayName)
                .replace("{price}", rupees(b.selected.effectivePaise))
            : b.unmetNote
              ? t("ib.nothingFits")
              : b.pickup && b.drop
                ? t("ib.gettingPrices")
                : t("ib.setBoth")}
      </button>
    </div>
  );
}
