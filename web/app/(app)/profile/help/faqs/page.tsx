"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useBackTo } from "@/lib/navHistory";
import { ArrowLeft, ChevronDown, ChevronRight } from "lucide-react";
import { api } from "@/lib/api";
import { cn } from "@/lib/cn";
import { useI18n } from "@/components/i18n/I18nContext";
import type { TranslationKey } from "@/lib/i18n/dictionaries";

// FAQs — the same knowledge base as the Help Centre and the chat assistant,
// grouped and expandable rather than one row per screen. One source means the
// three surfaces can never drift into contradicting each other.

type Topic = { slug: string; title: string; summary: string };
type Group = { group: string; topics: Topic[] };

const GROUP_KEY: Record<string, TranslationKey> = {
  orders: "pp.faq.orders",
  rides: "pp.faq.rides",
  payments: "pp.faq.payments",
  offers: "pp.faq.offers",
  account: "pp.faq.account",
};

export default function FaqsPage() {
  const goBack = useBackTo("/profile/help");
  const { t } = useI18n();
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api<{ groups: Group[] }>("/api/support/groups")
      .then((d) => {
        if (!cancelled) setGroups(d.groups);
      })
      .catch(() => {
        if (!cancelled) setGroups([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="min-h-dvh bg-acct-bg">
      <div className="mx-auto w-full max-w-xl px-4 pb-10 lg:max-w-[780px] lg:px-6">
        <div className="flex items-center py-4">
          <button
            onClick={goBack}
            aria-label={t("common.back")}
            className="tap-target flex size-9 shrink-0 items-center justify-center rounded-full bg-card shadow-soft transition-colors hover:bg-acct-bg"
          >
            <ArrowLeft size={18} className="text-acct-ink" />
          </button>
          <h1 className="flex-1 pr-9 text-center text-[17px] font-extrabold text-acct-ink">
            {t("pp.hc.faqs")}
          </h1>
        </div>

        {groups === null ? (
          <p className="py-8 text-center text-[13px] text-acct-muted">{t("common.loading")}</p>
        ) : (
          <div className="flex flex-col gap-3">
            {groups.map((g) => {
              const expanded = open === g.group;
              return (
                <div
                  key={g.group}
                  className="overflow-hidden rounded-[18px] bg-card shadow-soft"
                >
                  <button
                    onClick={() => setOpen(expanded ? null : g.group)}
                    aria-expanded={expanded}
                    className="flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors hover:bg-acct-bg"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block text-[15px] font-bold text-acct-ink">
                        {GROUP_KEY[g.group] ? t(GROUP_KEY[g.group]) : g.group}
                      </span>
                      <span className="block text-[12px] text-acct-muted">
                        {g.topics.length}{" "}
                        {t(g.topics.length === 1 ? "pp.faq.question" : "pp.faq.questions")}
                      </span>
                    </span>
                    <ChevronDown
                      size={17}
                      className={cn(
                        "shrink-0 text-acct-muted transition-transform",
                        expanded && "rotate-180",
                      )}
                    />
                  </button>

                  {expanded &&
                    g.topics.map((t) => (
                      <Link
                        key={t.slug}
                        href={`/profile/help/topics/${t.slug}`}
                        className="flex items-center gap-3 border-t border-line px-4 py-3 transition-colors hover:bg-acct-bg"
                      >
                        <span className="min-w-0 flex-1">
                          <span className="line-clamp-2 text-[14px] font-semibold text-acct-ink">
                            {t.title}
                          </span>
                          <span className="line-clamp-2 text-[12px] text-acct-muted">
                            {t.summary}
                          </span>
                        </span>
                        <ChevronRight size={16} className="shrink-0 text-acct-muted" />
                      </Link>
                    ))}
                </div>
              );
            })}
          </div>
        )}

        <Link
          href="/profile/help/contact"
          className="mt-5 flex h-[52px] w-full items-center justify-center rounded-pill border border-line bg-card text-[15px] font-bold text-acct-ink transition-colors hover:bg-acct-bg"
        >
          {t("pp.faq.stillNeed")}
        </Link>
      </div>
    </div>
  );
}
