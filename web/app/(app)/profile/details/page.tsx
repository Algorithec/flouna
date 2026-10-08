"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useBackTo } from "@/lib/navHistory";
import {
  ArrowLeft,
  UserRound,
  Mail,
  Phone,
  Calendar,
  MapPin,
  Pencil,
  ChevronRight,
  type LucideIcon,
} from "lucide-react";
import { api } from "@/lib/api";
import { useAuth, type User } from "@/components/auth/AuthContext";
import { useI18n } from "@/components/i18n/I18nContext";
import type { TranslationKey } from "@/lib/i18n/dictionaries";
import { Select } from "@/components/ui/Select";

// Figma "Personal Information" (2195:756): a read-only list of label/value
// pairs with an Edit Information button beneath.
//
// The frame is a view, not a form — so this is a view, and Edit flips the same
// rows into inputs rather than navigating to a second screen the design doesn't
// draw. Every value is real: Date of Birth was already stored at sign-up but
// never returned by the API, and Gender is a new nullable column, so neither
// row is placeholder text.
const GENDERS: { value: string; labelKey: TranslationKey }[] = [
  { value: "Female", labelKey: "pp.det.female" },
  { value: "Male", labelKey: "pp.det.male" },
  { value: "Non-binary", labelKey: "pp.det.nonBinary" },
  { value: "Prefer not to say", labelKey: "pp.det.preferNotSay" },
];

const GENDER_KEY: Record<string, TranslationKey> = Object.fromEntries(
  GENDERS.map((g) => [g.value, g.labelKey]),
);

/** "2002-03-12" -> "12 Mar 2002", the format the design shows. */
function formatDob(iso: string | null) {
  if (!iso) return null;
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

// Figma draws each field as an icon, a small label with the value beneath, and
// a chevron. The chevron is not decoration: tapping the row opens the same edit
// form the button does, so the affordance the design implies actually leads
// somewhere. Address is the exception — it lives in the address book, so that
// row goes there instead.
function Row({
  icon: Icon,
  label,
  value,
  onClick,
  href,
}: {
  icon: LucideIcon;
  label: string;
  value: string | null;
  onClick?: () => void;
  href?: string;
}) {
  const { t } = useI18n();
  const body = (
    <>
      <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-acct-tint">
        <Icon size={16} className="text-acct-accent" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[12px] text-acct-muted">{label}</span>
        <span
          className={`mt-0.5 block truncate text-[15px] font-semibold ${
            value ? "text-acct-ink" : "text-acct-muted"
          }`}
        >
          {value ?? t("pp.det.notAdded")}
        </span>
      </span>
      <ChevronRight size={17} className="shrink-0 text-acct-muted" />
    </>
  );

  const cls =
    "flex w-full items-center gap-3.5 border-b border-line px-4 py-3 text-left last:border-b-0 transition-colors hover:bg-acct-bg";

  if (href) {
    return (
      <Link href={href} className={cls}>
        {body}
      </Link>
    );
  }
  return (
    <button type="button" onClick={onClick} className={cls}>
      {body}
    </button>
  );
}

export default function ProfileDetailsPage() {
  const goBack = useBackTo("/profile");
  const { t } = useI18n();
  const { user, setUser } = useAuth();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(user?.name ?? "");
  const [phone, setPhone] = useState(user?.phone ?? "");
  const [dob, setDob] = useState(user?.dateOfBirth ?? "");
  const [gender, setGender] = useState(user?.gender ?? "");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [address, setAddress] = useState<string | null>(null);

  // The design shows a real address on this screen. It lives in the address
  // book rather than on the account, so the default one is read here and the
  // row links there instead of duplicating an editor.
  useEffect(() => {
    let cancelled = false;
    api<{ addresses: { line1: string; line2: string | null; city: string; state: string; isDefault: boolean }[] }>(
      "/api/users/addresses",
    )
      .then((d) => {
        if (cancelled) return;
        const a = d.addresses.find((x) => x.isDefault) ?? d.addresses[0];
        setAddress(a ? [a.city, a.state, "India"].filter(Boolean).join(", ") : null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const d = await api<{ user: User }>("/api/users/me", {
        method: "PATCH",
        json: {
          name,
          phone: phone.trim() || null,
          dateOfBirth: dob || null,
          gender: gender || null,
        },
      });
      setUser(d.user);
      setMessage(t("pp.det.saved"));
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("pd.saveFailed"));
    } finally {
      setBusy(false);
    }
  }

  const field =
    "h-[52px] w-full rounded-[12px] border border-line bg-card px-3.5 text-[15px] text-acct-ink outline-none focus:border-acct-accent focus:ring-2 focus:ring-acct-accent/12";
  const label = "text-[12px] text-acct-muted";

  return (
    <div className="min-h-dvh bg-acct-bg">
      <div className="mx-auto w-full max-w-xl px-4 pb-10 lg:max-w-[780px] lg:px-6">
        <div className="flex items-center gap-3 py-5">
          <button
            onClick={goBack}
            aria-label={t("common.back")}
            className="rounded-full p-2 text-acct-ink transition-colors hover:bg-acct-ink/5"
          >
            <ArrowLeft size={20} />
          </button>
          <h1 className="text-[18px] font-extrabold text-acct-ink">
            {t("pp.det.title")}
          </h1>
        </div>

        {editing ? (
          <form onSubmit={save} className="flex flex-col gap-4">
            <div className="rounded-[18px] bg-card p-4 shadow-soft">
              <div className="flex flex-col gap-4">
                <label className="flex flex-col gap-1.5">
                  <span className={label}>{t("pp.det.fullName")}</span>
                  <input
                    className={field}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    minLength={2}
                    required
                  />
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className={label}>{t("pp.det.email")}</span>
                  {/* Changing the sign-in address needs re-verification, which
                      this screen can't do — shown, but not editable here. */}
                  <input
                    className={`${field} cursor-not-allowed opacity-60`}
                    value={user?.email ?? ""}
                    disabled
                  />
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className={label}>{t("pp.det.phone")}</span>
                  <input
                    className={field}
                    type="tel"
                    inputMode="tel"
                    placeholder={t("pp.det.mobilePh")}
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                  />
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className={label}>{t("pp.det.dob")}</span>
                  <input
                    className={field}
                    type="date"
                    max={new Date().toISOString().slice(0, 10)}
                    value={dob}
                    onChange={(e) => setDob(e.target.value)}
                  />
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className={label}>{t("pp.det.gender")}</span>
                  <Select
                    value={gender}
                    label={t("pp.det.gender")}
                    options={[
                      { value: "", label: t("pp.det.preferNotSay") },
                      ...GENDERS.map((g) => ({ value: g.value, label: t(g.labelKey) })),
                    ]}
                    onChange={setGender}
                  />
                </label>
              </div>
            </div>

            {error && (
              <p role="alert" className="text-[14px] text-danger">
                {error}
              </p>
            )}

            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => {
                  setEditing(false);
                  setName(user?.name ?? "");
                  setPhone(user?.phone ?? "");
                  setDob(user?.dateOfBirth ?? "");
                  setGender(user?.gender ?? "");
                  setError("");
                }}
                className="h-[52px] flex-1 rounded-pill border border-line bg-card text-[16px] font-bold text-acct-ink transition-colors hover:bg-acct-bg"
              >
                {t("common.cancel")}
              </button>
              <button
                type="submit"
                disabled={busy}
                className="h-[52px] flex-[2] rounded-pill bg-acct-accent text-[16px] font-bold text-white transition-opacity hover:opacity-90 disabled:opacity-60"
              >
                {busy ? t("pp.det.saving") : t("pp.det.saveChanges")}
              </button>
            </div>
          </form>
        ) : (
          <>
            <div className="overflow-hidden rounded-[18px] bg-card shadow-soft">
              <Row
                icon={UserRound}
                label={t("pp.det.fullName")}
                value={user?.name ?? null}
                onClick={() => setEditing(true)}
              />
              <Row
                icon={Mail}
                label={t("pp.det.email")}
                value={user?.email ?? null}
                onClick={() => setEditing(true)}
              />
              <Row
                icon={Phone}
                label={t("pp.det.phone")}
                value={user?.phone ?? null}
                onClick={() => setEditing(true)}
              />
              <Row
                icon={Calendar}
                label={t("pp.det.dob")}
                value={formatDob(user?.dateOfBirth ?? null)}
                onClick={() => setEditing(true)}
              />
              <Row
                icon={UserRound}
                label={t("pp.det.gender")}
                value={user?.gender && GENDER_KEY[user.gender] ? t(GENDER_KEY[user.gender]) : (user?.gender ?? null)}
                onClick={() => setEditing(true)}
              />
              {/* Address lives in the saved-addresses book, which has its own
                  screen — linked rather than duplicated here. */}
              <Row
                icon={MapPin}
                label={t("pd.address")}
                value={address}
                href="/profile/addresses"
              />
            </div>

            {message && (
              <p className="mt-3 text-center text-[14px] text-success">{message}</p>
            )}

            <button
              onClick={() => setEditing(true)}
              className="mt-6 flex h-[54px] w-full items-center justify-center gap-2 rounded-pill border-[1.5px] border-acct-accent bg-card text-[16px] font-bold text-acct-ink transition-colors hover:bg-acct-tint"
            >
              <Pencil size={17} />
              {t("pp.det.editInfo")}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
