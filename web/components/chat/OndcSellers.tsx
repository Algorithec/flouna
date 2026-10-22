"use client";

// Dishes from ONDC sellers near the customer, shown under a food answer.
//
// The search went to every food seller app on the network when the question
// was asked; their stores answer over the following seconds. This polls the
// server's collected answers until the search window closes, so sellers
// appear as they reply, each with who they are and where.

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, MapPin, Store } from "lucide-react";
import { api } from "@/lib/api";
import { rupees } from "@/lib/money";
import { cn } from "@/lib/cn";
import { useI18n } from "@/components/i18n/I18nContext";

type Offer = {
  itemId: string;
  name: string;
  image?: string;
  pricePaise: number;
  customizable: boolean;
  veg: boolean | null;
  distanceKm: number | null;
  seller: {
    bppId: string;
    providerId: string;
    locationId: string;
    appName: string;
    name: string;
    logo?: string;
    address: { locality?: string; city?: string };
    fssaiLicence?: string;
  };
};
type Results = { status: "searching" | "complete" | "refused"; stores: number; sellerApps: number; offers: Offer[] };

export type OndcSearchRef = { searchId: string } | { unavailable: string };

const POLL_MS = 2500;

export function OndcSellers({ ondc }: { ondc: OndcSearchRef }) {
  const { t } = useI18n();
  const [results, setResults] = useState<Results | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [starting, setStarting] = useState<string | null>(null);
  const [startFailed, setStartFailed] = useState<string | null>(null);
  const router = useRouter();
  const searchId = "searchId" in ondc ? ondc.searchId : null;

  // One dish from one store: the seller prices it for this address, and the
  // order screen follows it from there.
  async function order(o: Offer, key: string) {
    if (!searchId || starting) return;
    setStarting(key);
    setStartFailed(null);
    try {
      const r = await api<{ orderId: string }>("/api/ondc/orders", {
        method: "POST",
        json: {
          searchId,
          bppId: o.seller.bppId,
          providerId: o.seller.providerId,
          locationId: o.seller.locationId,
          lines: [{ itemId: o.itemId, count: 1 }],
        },
      });
      router.push(`/food/ondc/${r.orderId}`);
    } catch {
      setStartFailed(key);
      setStarting(null);
    }
  }

  useEffect(() => {
    if (!searchId) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const r = await api<Results>(`/api/ondc/search/${searchId}`);
        if (!alive) return;
        setResults(r);
        if (r.status === "searching") timer = setTimeout(poll, POLL_MS);
      } catch {
        // A reopened chat whose search has gone: show nothing rather than an error.
        if (alive) setResults({ status: "complete", stores: 0, sellerApps: 0, offers: [] });
      }
    };
    void poll();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [searchId]);

  if (!searchId) {
    return <p className="mt-3 text-[12px] text-cocoa">{(ondc as { unavailable: string }).unavailable}</p>;
  }
  const searching = !results || results.status === "searching";
  const offers = results?.offers ?? [];
  if (!searching && offers.length === 0) {
    return <p className="mt-3 text-[12px] text-cocoa">{results?.status === "refused" ? t("on.refused") : t("on.none")}</p>;
  }
  const shown = showAll ? offers : offers.slice(0, 4);

  return (
    <section className="mt-4">
      <div className="flex items-center gap-2">
        <Store size={15} className="text-accent" />
        <h3 className="text-[13px] font-semibold text-ink">{t("on.title")}</h3>
        <span className="ml-auto flex items-center gap-1 text-[11px] text-cocoa">
          {searching && <Loader2 size={12} className="animate-spin" />}
          {searching ? t("on.searching") : t("on.stores").replace("{n}", String(results?.stores ?? 0))}
        </span>
      </div>
      <ul className="mt-2 space-y-2">
        {shown.map((o) => {
          const key = `${o.seller.bppId}|${o.seller.providerId}|${o.seller.locationId}|${o.itemId}`;
          return (
          <li key={key} className="flex gap-3 rounded-card border border-line bg-card p-2.5">
            <SellerImage src={o.image ?? o.seller.logo} />
            <div className="min-w-0 flex-1">
              <div className="flex items-start gap-1.5">
                {o.veg !== null && (
                  <span
                    aria-label={o.veg ? t("on.veg") : t("on.nonVeg")}
                    className={cn("mt-1 h-2.5 w-2.5 shrink-0 rounded-sm border", o.veg ? "border-green-600 bg-green-600/80" : "border-red-600 bg-red-600/80")}
                  />
                )}
                <p className="min-w-0 truncate text-[13px] font-semibold text-ink">{o.name}</p>
                <p className="ml-auto shrink-0 text-[13px] font-semibold text-ink">
                  {o.customizable ? t("on.from").replace("{price}", rupees(o.pricePaise)) : rupees(o.pricePaise)}
                </p>
              </div>
              <p className="truncate text-[12px] text-ink">
                {o.seller.name} <span className="text-cocoa">{t("on.via").replace("{app}", o.seller.appName)}</span>
              </p>
              <p className="flex items-center gap-1 truncate text-[11px] text-cocoa">
                <MapPin size={11} className="shrink-0" />
                {[o.seller.address.locality, o.seller.address.city].filter(Boolean).join(", ")}
                {o.distanceKm !== null && ` · ${t("on.away").replace("{km}", String(o.distanceKm))}`}
              </p>
              {o.seller.fssaiLicence && <p className="truncate text-[10px] text-cocoa/80">{t("on.fssai").replace("{no}", o.seller.fssaiLicence)}</p>}
              {/* Choices such as size or crust come from the seller's
                  customisation groups, which are not read yet, so those
                  dishes say so instead of ordering without them. */}
              {o.customizable ? (
                <p className="mt-1 text-[11px] text-cocoa">{t("on.optionsSoon")}</p>
              ) : (
                <div className="mt-1.5 flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => order(o, key)}
                    disabled={starting !== null}
                    className="tap-target rounded-pill bg-btn px-3.5 py-1.5 text-[12px] font-semibold text-white transition-colors hover:bg-btn-hover disabled:bg-btn/50"
                  >
                    {starting === key ? t("on.starting") : t("on.order")}
                  </button>
                  {startFailed === key && <span className="text-[11px] text-danger">{t("on.startFailed")}</span>}
                </div>
              )}
            </div>
          </li>
          );
        })}
      </ul>
      {offers.length > 4 && !showAll && (
        <button type="button" onClick={() => setShowAll(true)} className="tap-target mt-2 w-full rounded-pill border border-line py-2 text-[12px] font-semibold text-ink">
          {t("on.more").replace("{n}", String(offers.length - 4))}
        </button>
      )}
    </section>
  );
}

/**
 * A seller's own image link, which may be broken or slow: a failed one falls
 * back to the plain tile rather than showing a broken image icon.
 */
function SellerImage({ src }: { src?: string }) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) return <div className="h-14 w-14 shrink-0 rounded-md bg-beige" />;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt="" onError={() => setFailed(true)} className="h-14 w-14 shrink-0 rounded-md bg-beige object-cover" loading="lazy" referrerPolicy="no-referrer" />
  );
}
