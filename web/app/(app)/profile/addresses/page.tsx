"use client";

// Addresses — Figma "Edit Address" screen adapted to the theme: label chips,
// receiver contact, flat/building/landmark split, use-current-location
// capture, and full edit + delete on saved addresses.

import { useEffect, useState } from "react";
import { MapPin, Trash2, Plus, Pencil, LocateFixed, Check } from "lucide-react";
import { api } from "@/lib/api";
import { SubPage } from "@/components/profile/SubPage";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import { useI18n } from "@/components/i18n/I18nContext";

type Address = {
  id: string;
  label: string;
  line1: string;
  line2?: string | null;
  landmark?: string | null;
  contactName?: string | null;
  contactPhone?: string | null;
  city: string;
  state: string;
  pincode: string;
  lat?: number | null;
  lng?: number | null;
  isDefault: boolean;
};

type Form = {
  label: string;
  line1: string;
  line2: string;
  landmark: string;
  contactName: string;
  contactPhone: string;
  city: string;
  state: string;
  pincode: string;
  lat?: number;
  lng?: number;
};

const EMPTY: Form = {
  label: "Home",
  line1: "",
  line2: "",
  landmark: "",
  contactName: "",
  contactPhone: "",
  city: "",
  state: "",
  pincode: "",
};

const LABELS = ["Home", "Work", "Other"];

export default function AddressesPage() {
  const { t } = useI18n();
  const [addresses, setAddresses] = useState<Address[]>([]);
  const [form, setForm] = useState<Form>(EMPTY);
  const [editingId, setEditingId] = useState<string | null>(null); // null = closed, "" = adding
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [located, setLocated] = useState(false);
  const formOpen = editingId !== null;

  const load = () =>
    api<{ addresses: Address[] }>("/api/users/addresses")
      .then((d) => setAddresses(d.addresses))
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load"));

  useEffect(() => {
    load();
  }, []);

  function openAdd() {
    setForm(EMPTY);
    setLocated(false);
    setEditingId("");
    setError("");
  }

  function openEdit(a: Address) {
    setForm({
      label: a.label,
      line1: a.line1,
      line2: a.line2 ?? "",
      landmark: a.landmark ?? "",
      contactName: a.contactName ?? "",
      contactPhone: a.contactPhone ?? "",
      city: a.city,
      state: a.state,
      pincode: a.pincode,
      lat: a.lat ?? undefined,
      lng: a.lng ?? undefined,
    });
    setLocated(Boolean(a.lat && a.lng));
    setEditingId(a.id);
    setError("");
  }

  function useCurrentLocation() {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setForm((f) => ({ ...f, lat: pos.coords.latitude, lng: pos.coords.longitude }));
        setLocated(true);
      },
      () => setError("Couldn't read your location — check browser permissions."),
    );
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    // Optional fields go only when filled — the API validates the rest.
    const payload = {
      label: form.label,
      line1: form.line1,
      city: form.city,
      state: form.state,
      pincode: form.pincode,
      ...(form.line2.trim() ? { line2: form.line2.trim() } : {}),
      ...(form.landmark.trim() ? { landmark: form.landmark.trim() } : {}),
      ...(form.contactName.trim() ? { contactName: form.contactName.trim() } : {}),
      ...(form.contactPhone.trim() ? { contactPhone: form.contactPhone.trim() } : {}),
      ...(form.lat !== undefined && form.lng !== undefined
        ? { lat: form.lat, lng: form.lng }
        : {}),
      isDefault: editingId
        ? (addresses.find((a) => a.id === editingId)?.isDefault ?? false)
        : addresses.length === 0,
    };
    try {
      if (editingId) {
        await api(`/api/users/addresses/${editingId}`, { method: "PATCH", json: payload });
      } else {
        await api("/api/users/addresses", { method: "POST", json: payload });
      }
      setEditingId(null);
      setForm(EMPTY);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save address");
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    await api(`/api/users/addresses/${id}`, { method: "DELETE" }).catch(() => {});
    if (editingId === id) setEditingId(null);
    await load();
  }

  return (
    <SubPage title={t("profile.address")}>
      <div className="flex flex-col gap-2.5">
        {addresses.map((a) => (
          <Card key={a.id}>
            <div className="flex items-start gap-3">
              <MapPin size={16} className="mt-0.5 shrink-0 text-accent" />
              <div className="min-w-0 flex-1">
                <p className="text-[14px] font-bold text-ink">
                  {a.label}
                  {a.isDefault && (
                    <span className="ml-2 rounded-full bg-accent-soft px-2 py-0.5 text-[10px] font-semibold text-accent">
                      {t("pp.addr.default")}
                    </span>
                  )}
                </p>
                <p className="text-[12px] text-cocoa">
                  {[a.line1, a.line2, a.landmark].filter(Boolean).join(", ")}, {a.city},{" "}
                  {a.state} — {a.pincode}
                </p>
                {(a.contactName || a.contactPhone) && (
                  <p className="mt-0.5 text-[11px] text-cocoa/80">
                    {[a.contactName, a.contactPhone].filter(Boolean).join(" · ")}
                  </p>
                )}
              </div>
              <button
                onClick={() => openEdit(a)}
                aria-label={`Edit ${a.label}`}
                className="rounded-full p-1.5 text-cocoa/60 transition-colors hover:bg-beige/60 hover:text-ink"
              >
                <Pencil size={14} />
              </button>
              <button
                onClick={() => remove(a.id)}
                aria-label={`Delete ${a.label}`}
                className="rounded-full p-1.5 text-cocoa/60 transition-colors hover:bg-danger/10 hover:text-danger"
              >
                <Trash2 size={15} />
              </button>
            </div>
          </Card>
        ))}
        {addresses.length === 0 && !formOpen && (
          <p className="py-6 text-center text-[13px] text-cocoa">{t("pp.addr.empty")}</p>
        )}
      </div>

      {formOpen ? (
        <form onSubmit={save} className="mt-4 flex flex-col gap-3">
          <p className="text-[14px] font-bold text-ink">
            {editingId ? t("pp.addr.editTitle") : t("pp.addr.newTitle")}
          </p>

          {/* Use current location */}
          <button
            type="button"
            onClick={useCurrentLocation}
            className={cn(
              "flex items-center gap-2.5 rounded-card border px-3.5 py-3 text-left text-[13px] font-semibold transition-colors",
              located
                ? "border-success/40 bg-success/5 text-success"
                : "border-line bg-card text-accent hover:bg-accent-soft/40",
            )}
          >
            {located ? <Check size={16} /> : <LocateFixed size={16} />}
            {located
              ? t("pp.addr.located")
              : t("pp.addr.useLocation")}
          </button>

          {/* Label chips */}
          <div className="flex gap-2">
            {LABELS.map((l) => (
              <button
                key={l}
                type="button"
                onClick={() => setForm({ ...form, label: l })}
                className={cn(
                  "rounded-pill px-4 py-1.5 text-[12px] font-semibold transition-colors",
                  form.label === l ||
                    (l === "Other" && !["Home", "Work"].includes(form.label))
                    ? "bg-cocoa text-white"
                    : "border border-line bg-card text-cocoa hover:bg-beige/40",
                )}
              >
                {l}
              </button>
            ))}
          </div>
          {!["Home", "Work"].includes(form.label) && (
            <Input
              label={t("pp.addr.label")}
              placeholder="e.g. Parents' place"
              value={form.label === "Other" ? "" : form.label}
              onChange={(e) => setForm({ ...form, label: e.target.value || "Other" })}
            />
          )}

          {/* Receiver contact */}
          <div className="grid grid-cols-2 gap-3">
            <Input
              label={t("pp.det.fullName")}
              placeholder={t("pp.addr.receiverPh")}
              value={form.contactName}
              onChange={(e) => setForm({ ...form, contactName: e.target.value })}
            />
            <Input
              label={t("pp.det.mobile")}
              inputMode="numeric"
              placeholder="98765 43210"
              value={form.contactPhone}
              onChange={(e) =>
                setForm({
                  ...form,
                  contactPhone: e.target.value.replace(/\D/g, "").slice(0, 10),
                })
              }
            />
          </div>

          <Input
            label={t("pp.addr.flat")}
            placeholder="Flat No. 402"
            value={form.line1}
            onChange={(e) => setForm({ ...form, line1: e.target.value })}
            required
          />
          <Input
            label={t("pp.addr.building")}
            placeholder="Sunrise Apartments, MG Road"
            value={form.line2}
            onChange={(e) => setForm({ ...form, line2: e.target.value })}
          />
          <Input
            label={t("pp.addr.landmark")}
            placeholder="Near the metro station"
            value={form.landmark}
            onChange={(e) => setForm({ ...form, landmark: e.target.value })}
          />
          <div className="grid grid-cols-2 gap-3">
            <Input
              label={t("pp.addr.city")}
              value={form.city}
              onChange={(e) => setForm({ ...form, city: e.target.value })}
              required
            />
            <Input
              label={t("pp.addr.state")}
              value={form.state}
              onChange={(e) => setForm({ ...form, state: e.target.value })}
              required
            />
          </div>
          <Input
            label={t("pp.addr.pin")}
            inputMode="numeric"
            value={form.pincode}
            onChange={(e) =>
              setForm({ ...form, pincode: e.target.value.replace(/\D/g, "").slice(0, 6) })
            }
            required
          />
          {error && <p className="text-[13px] text-danger">{error}</p>}
          <div className="flex gap-2">
            <Button type="submit" size="md" disabled={busy} className="flex-1">
              {busy
                ? t("pp.addr.saving")
                : editingId
                  ? t("pp.addr.update")
                  : t("pp.addr.save")}
            </Button>
            <Button
              type="button"
              size="md"
              variant="secondary"
              onClick={() => setEditingId(null)}
            >
              {t("common.cancel")}
            </Button>
          </div>
        </form>
      ) : (
        <Button variant="secondary" size="md" onClick={openAdd} className="mt-4 w-full">
          <Plus size={16} /> {t("pp.addr.addNew")}
        </Button>
      )}
    </SubPage>
  );
}
