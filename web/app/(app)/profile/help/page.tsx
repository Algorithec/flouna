"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { ChevronDown, Mail, LifeBuoy, CheckCircle2, Send } from "lucide-react";
import { api, ApiClientError } from "@/lib/api";
import { SubPage } from "@/components/profile/SubPage";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { cn } from "@/lib/cn";
import { useI18n } from "@/components/i18n/I18nContext";
import type { TranslationKey } from "@/lib/i18n/dictionaries";

// Question/answer and label copy lives in the dictionaries; these tables hold
// only the keys so the component resolves them through t().
const FAQS: { q: TranslationKey; a: TranslationKey }[] = [
  { q: "pp.help.q1", a: "pp.help.a1" },
  { q: "pp.help.q2", a: "pp.help.a2" },
  { q: "pp.help.q3", a: "pp.help.a3" },
  { q: "pp.help.q4", a: "pp.help.a4" },
];

const CATEGORIES: { key: string; label: TranslationKey }[] = [
  { key: "order", label: "pp.help.catOrder" },
  { key: "payment", label: "pp.help.catPayment" },
  { key: "refund", label: "pp.help.catRefund" },
  { key: "account", label: "pp.help.catAccount" },
  { key: "other", label: "pp.help.catOther" },
];

type Ticket = {
  id: string;
  category: string;
  subject: string;
  status: "open" | "in_progress" | "resolved" | "closed";
  priority: string;
  resolution: string | null;
  createdAt: string;
  updatedAt: string;
};

type OrderSummary = { id: string; title: string; status?: string; createdAt: string };

const STATUS_BADGE: Record<Ticket["status"], { label: TranslationKey; cls: string }> = {
  open: { label: "pp.help.stOpen", cls: "bg-accent-soft text-accent" },
  in_progress: { label: "pp.help.stInProgress", cls: "bg-beige text-cocoa" },
  resolved: { label: "pp.help.stResolved", cls: "bg-success/10 text-success" },
  closed: { label: "pp.help.stClosed", cls: "bg-line text-muted" },
};

export default function HelpPage() {
  return (
    <Suspense fallback={null}>
      <HelpInner />
    </Suspense>
  );
}

function HelpInner() {
  // Bound as `tr` because ticket rows below use `t` as their loop variable.
  const { t: tr } = useI18n();
  const prefillOrder = useSearchParams().get("order") ?? "";

  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [orders, setOrders] = useState<OrderSummary[]>([]);
  const [openFaq, setOpenFaq] = useState<number | null>(null);
  const [openTicket, setOpenTicket] = useState<string | null>(null);

  // Form state. When arriving via "Report an issue" on an order, the order is
  // pre-linked and the category defaults to "order".
  const [category, setCategory] = useState<(typeof CATEGORIES)[number]["key"]>(
    prefillOrder ? "order" : "other",
  );
  const [orderId, setOrderId] = useState(prefillOrder);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");

  function loadTickets() {
    api<{ tickets: Ticket[] }>("/api/users/tickets")
      .then((d) => setTickets(d.tickets))
      .catch(() => setTickets([]));
  }

  useEffect(() => {
    loadTickets();
    api<{ orders: OrderSummary[] }>("/api/orders")
      .then(async (d) => {
        let list = d.orders.slice(0, 10);
        // Deep-linked from "Report an issue" on an order that's older than the
        // top-10 slice: resolve it so the dropdown shows it as selected instead
        // of silently displaying the placeholder.
        if (prefillOrder && !list.some((o) => o.id === prefillOrder)) {
          const linked = await api<{ order: OrderSummary }>(`/api/orders/${prefillOrder}`)
            .then((r) => r.order)
            .catch(() => null);
          if (linked) list = [linked, ...list];
        }
        setOrders(list);
      })
      .catch(() => setOrders([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    setSent(false);
    try {
      await api("/api/users/tickets", {
        method: "POST",
        json: {
          category,
          subject,
          body,
          ...(orderId ? { orderId } : {}),
        },
      });
      setSent(true);
      setSubject("");
      setBody("");
      loadTickets();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Couldn't send — try again.");
    } finally {
      setBusy(false);
    }
  }

  // Latest live order for the "current order help" card (Figma).
  const liveOrder = orders.find((o) =>
    ["confirmed", "in_progress"].includes((o as { status?: string }).status ?? ""),
  ) as (OrderSummary & { status?: string }) | undefined;

  // One-tap intents: pre-fill the ticket form and link the live order.
  function prefill(cat: string, subj: string, linkOrder = true) {
    setCategory(cat);
    setSubject(subj);
    if (linkOrder && liveOrder) setOrderId(liveOrder.id);
  }

  return (
    <SubPage title={tr("pp.help.title")}>
      {/* Current order help — Figma: live order + one-tap intents */}
      {liveOrder && (
        <Card className="mb-4">
          <div className="flex items-center justify-between">
            <p className="text-[14px] font-bold text-ink">Current order help</p>
            <span className="flex items-center gap-1 rounded-pill bg-accent-soft px-2 py-0.5 text-[10px] font-bold text-accent">
              <span className="size-1.5 animate-pulse rounded-full bg-accent" /> LIVE
            </span>
          </div>
          <div className="mt-2.5 flex items-center gap-3 rounded-card bg-beige/40 px-3 py-2.5">
            <p className="min-w-0 flex-1 truncate text-[13px] font-semibold text-ink">
              {liveOrder.title}
            </p>
            <Link
              href={`/orders/${liveOrder.id}`}
              className="shrink-0 rounded-pill bg-accent px-3.5 py-1.5 text-[12px] font-semibold text-white hover:bg-[#d4570f]"
            >
              Track
            </Link>
          </div>
          <div className="mt-2 flex flex-col divide-y divide-line/70">
            <Link
              href={`/orders/${liveOrder.id}`}
              className="py-2.5 text-[13px] text-ink hover:text-accent"
            >
              I want to cancel my order
              <span className="block text-[11px] text-cocoa">
                Cancel from the order screen before pickup
              </span>
            </Link>
            <button
              onClick={() => prefill("order", "Order is taking too long")}
              className="py-2.5 text-left text-[13px] text-ink hover:text-accent"
            >
              Order is taking too long
              <span className="block text-[11px] text-cocoa">
                Raise it below — we chase the delivery partner
              </span>
            </button>
            <button
              onClick={() => prefill("order", "Wrong delivery address")}
              className="py-2.5 text-left text-[13px] text-ink hover:text-accent"
            >
              Wrong delivery address
              <span className="block text-[11px] text-cocoa">
                Tell us before pickup and we update it
              </span>
            </button>
          </div>
        </Card>
      )}

      {/* Quick actions — Figma grid */}
      <div className="mb-4 grid grid-cols-4 gap-2">
        <QuickAction
          label="Refund status"
          onClick={() => prefill("refund", "Where is my refund?", false)}
        />
        <QuickAction
          label="Payment issue"
          onClick={() => prefill("payment", "Payment problem", false)}
        />
        <QuickAction label="Rate order" href="/history" />
        <QuickAction
          label="Missing item"
          onClick={() => prefill("order", "Item missing from my order")}
        />
      </div>

      {/* Raise a ticket */}
      <Card>
        <h2 className="flex items-center gap-1.5 text-[14px] font-bold text-ink">
          <LifeBuoy size={15} className="text-accent" /> {tr("pp.help.raise")}
        </h2>
        <p className="mt-1 text-[12px] leading-relaxed text-cocoa">
          {tr("pp.help.intro")}
        </p>

        <form onSubmit={submit} className="mt-4 flex flex-col gap-3.5">
          {/* Category chips */}
          <div className="flex flex-wrap gap-2">
            {CATEGORIES.map((c) => (
              <button
                key={c.key}
                type="button"
                onClick={() => setCategory(c.key)}
                className={cn(
                  "rounded-pill px-3.5 py-1.5 text-[12px] font-semibold transition-colors",
                  category === c.key
                    ? "bg-cocoa text-white"
                    : "border border-line bg-card text-cocoa hover:bg-beige/40",
                )}
              >
                {tr(c.label)}
              </button>
            ))}
          </div>

          {/* Optional order link */}
          {orders.length > 0 && (
            <label className="block">
              <span className="mb-1.5 block text-[12px] font-semibold text-cocoa">
                {tr("pp.help.aboutOrder")}
              </span>
              <select
                value={orderId}
                onChange={(e) => setOrderId(e.target.value)}
                className="h-12 w-full rounded-pill border border-line bg-card px-4 text-[14px] text-ink outline-none focus:border-accent"
              >
                <option value="">{tr("pp.help.notAboutOrder")}</option>
                {orders.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.title} · {new Date(o.createdAt).toLocaleDateString("en-IN")}
                  </option>
                ))}
              </select>
            </label>
          )}

          <Input
            label={tr("pp.help.subject")}
            placeholder={tr("pp.help.subjectPh")}
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            minLength={3}
            maxLength={140}
            required
          />

          <label className="block">
            <span className="mb-1.5 block text-[12px] font-semibold text-cocoa">
              {tr("pp.help.whatHappened")}
            </span>
            <textarea
              required
              minLength={5}
              maxLength={2000}
              rows={4}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder={tr("pp.help.detailsPh")}
              className="w-full resize-none rounded-card border border-line bg-card px-4 py-3 text-[14px] leading-relaxed text-ink outline-none placeholder:text-muted focus:border-accent"
            />
          </label>

          {error && <p className="text-[13px] text-danger">{error}</p>}
          {sent && (
            <p className="flex items-center gap-1.5 text-[13px] font-medium text-success">
              <CheckCircle2 size={15} /> {tr("pp.help.raised")}
            </p>
          )}

          <button
            type="submit"
            disabled={busy || subject.trim().length < 3 || body.trim().length < 5}
            className="flex h-12 items-center justify-center gap-2 rounded-pill bg-cocoa text-[14px] font-semibold text-white transition-colors hover:bg-ink disabled:opacity-50"
          >
            <Send size={15} /> {busy ? tr("pp.help.sending") : tr("pp.help.submit")}
          </button>
        </form>
      </Card>

      {/* My tickets */}
      {tickets.length > 0 && (
        <div className="mt-5">
          <h2 className="mb-2.5 text-[14px] font-bold text-ink">{tr("pp.help.myTickets")}</h2>
          <div className="flex flex-col gap-2.5">
            {tickets.map((t) => {
              const badge = STATUS_BADGE[t.status] ?? STATUS_BADGE.open;
              const expanded = openTicket === t.id;
              return (
                <Card key={t.id} className="p-0">
                  <button
                    onClick={() => setOpenTicket(expanded ? null : t.id)}
                    className="flex w-full items-center gap-3 px-4 py-3.5 text-left"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[14px] font-semibold text-ink">
                        {t.subject}
                      </p>
                      <p className="mt-0.5 text-[11px] capitalize text-muted">
                        {t.category} ·{" "}
                        {new Date(t.createdAt).toLocaleDateString("en-IN", {
                          day: "2-digit",
                          month: "short",
                        })}
                      </p>
                    </div>
                    <span
                      className={cn(
                        "shrink-0 rounded-pill px-2.5 py-1 text-[11px] font-bold",
                        badge.cls,
                      )}
                    >
                      {tr(badge.label)}
                    </span>
                    <ChevronDown
                      size={15}
                      className={cn(
                        "shrink-0 text-cocoa transition-transform",
                        expanded && "rotate-180",
                      )}
                    />
                  </button>
                  {expanded && (
                    <div className="border-t border-line px-4 py-3.5">
                      {t.resolution ? (
                        <>
                          <p className="text-[11px] font-bold uppercase tracking-wide text-success">
                            Support reply
                          </p>
                          <p className="mt-1 text-[13px] leading-relaxed text-ink">
                            {t.resolution}
                          </p>
                        </>
                      ) : (
                        <p className="text-[13px] text-cocoa">
                          Our team is on it — the reply will appear here.
                        </p>
                      )}
                    </div>
                  )}
                </Card>
              );
            })}
          </div>
        </div>
      )}

      {/* FAQs */}
      <h2 className="mb-2.5 mt-6 text-[14px] font-bold text-ink">{tr("pp.help.faqs")}</h2>
      <div className="flex flex-col gap-2.5">
        {FAQS.map((f, i) => (
          <Card key={i} className="p-0">
            <button
              onClick={() => setOpenFaq(openFaq === i ? null : i)}
              className="flex w-full items-center gap-3 px-4 py-3.5 text-left"
            >
              <span className="flex-1 text-[14px] font-semibold text-ink">{tr(f.q)}</span>
              <ChevronDown
                size={16}
                className={cn(
                  "shrink-0 text-cocoa transition-transform",
                  openFaq === i && "rotate-180",
                )}
              />
            </button>
            {openFaq === i && (
              <p className="px-4 pb-4 text-[13px] leading-relaxed text-cocoa">{tr(f.a)}</p>
            )}
          </Card>
        ))}
      </div>

      <a
        href="mailto:support@radiues.app"
        className="mt-5 flex items-center justify-center gap-2 rounded-pill border border-line bg-card py-3 text-[14px] font-semibold text-ink transition-colors hover:bg-beige/40"
      >
        <Mail size={16} className="text-accent" /> Contact support
      </a>
    </SubPage>
  );
}

// Small quick-action tile (Figma "Quick Actions" grid).
function QuickAction({
  label,
  onClick,
  href,
}: {
  label: string;
  onClick?: () => void;
  href?: string;
}) {
  const cls =
    "flex flex-col items-center gap-1.5 rounded-card border border-line bg-card px-2 py-3 text-center text-[11px] font-semibold text-ink transition-colors hover:bg-beige/40";
  const icon = (
    <span className="flex size-8 items-center justify-center rounded-full bg-accent-soft">
      <LifeBuoy size={15} className="text-accent" />
    </span>
  );
  return href ? (
    <Link href={href} className={cls}>
      {icon}
      {label}
    </Link>
  ) : (
    <button onClick={onClick} className={cls}>
      {icon}
      {label}
    </button>
  );
}
