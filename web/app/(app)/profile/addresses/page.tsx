"use client";

import { useEffect, useState } from "react";
import { MapPin, Trash2, Plus } from "lucide-react";
import { api } from "@/lib/api";
import { SubPage } from "@/components/profile/SubPage";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { useI18n } from "@/components/i18n/I18nContext";

type Address = {
  id: string;
  label: string;
  line1: string;
  city: string;
  state: string;
  pincode: string;
  isDefault: boolean;
};

const EMPTY = { label: "", line1: "", city: "", state: "", pincode: "" };

export default function AddressesPage() {
  const { t } = useI18n();
  const [addresses, setAddresses] = useState<Address[]>([]);
  const [form, setForm] = useState(EMPTY);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = () =>
    api<{ addresses: Address[] }>("/api/users/addresses")
      .then((d) => setAddresses(d.addresses))
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load"));

  useEffect(() => {
    load();
  }, []);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/api/users/addresses", {
        method: "POST",
        json: { ...form, isDefault: addresses.length === 0 },
      });
      setForm(EMPTY);
      setAdding(false);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save address");
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    await api(`/api/users/addresses/${id}`, { method: "DELETE" }).catch(() => {});
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
                  {a.line1}, {a.city}, {a.state} — {a.pincode}
                </p>
              </div>
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
        {addresses.length === 0 && !adding && (
          <p className="py-6 text-center text-[13px] text-cocoa">
            {t("pp.addr.empty")}
          </p>
        )}
      </div>

      {adding ? (
        <form onSubmit={add} className="mt-4 flex flex-col gap-3">
          <Input
            label={t("pp.addr.label")}
            placeholder={t("pp.addr.labelPh")}
            value={form.label}
            onChange={(e) => setForm({ ...form, label: e.target.value })}
            required
          />
          <Input
            label={t("pp.addr.address")}
            placeholder={t("pp.addr.addressPh")}
            value={form.line1}
            onChange={(e) => setForm({ ...form, line1: e.target.value })}
            required
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
              {busy ? t("pp.addr.saving") : t("pp.addr.save")}
            </Button>
            <Button
              type="button"
              size="md"
              variant="secondary"
              onClick={() => setAdding(false)}
            >
              {t("common.cancel")}
            </Button>
          </div>
        </form>
      ) : (
        <Button
          variant="secondary"
          size="md"
          onClick={() => setAdding(true)}
          className="mt-4 w-full"
        >
          <Plus size={16} /> {t("pp.addr.addNew")}
        </Button>
      )}
    </SubPage>
  );
}
