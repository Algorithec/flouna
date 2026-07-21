"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Users, ChevronLeft } from "lucide-react";
import { api } from "@/lib/api";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import type { GroupCart } from "@/components/food/GroupCartTypes";

export default function GroupStartPage() {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function create() {
    setBusy(true);
    setError("");
    try {
      // All group orders fulfil in-app — no network choice to make.
      const cart = await api<GroupCart>("/api/groups", {
        method: "POST",
        json: { platform: "ondc" },
      });
      router.push(`/food/group/${cart.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not start group order");
      setBusy(false);
    }
  }

  async function join() {
    setBusy(true);
    setError("");
    try {
      const cart = await api<GroupCart>("/api/groups/join", {
        method: "POST",
        json: { code: code.trim().toUpperCase() },
      });
      // One code space for both kinds — ride codes land on the shared-ride screen.
      router.push(
        cart.domain === "ride" ? `/rides/group/${cart.id}` : `/food/group/${cart.id}`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not join");
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-xl px-4 py-6 lg:px-6">
      <button
        onClick={() => router.push("/food")}
        className="flex items-center gap-1 text-[13px] font-medium text-cocoa hover:text-ink"
      >
        <ChevronLeft size={16} /> Food
      </button>

      <h1 className="mt-3 flex items-center gap-2 text-[20px] font-bold text-ink">
        <Users size={20} className="text-accent" /> Group order
      </h1>
      <p className="mt-1 text-[13px] text-cocoa">
        Order together with friends — everyone adds their items, the bill splits
        equally.
      </p>

      {/* Start new */}
      <Card className="mt-5">
        <p className="text-[14px] font-bold text-ink">Start a new group order</p>
        <p className="mt-1 text-[12px] text-cocoa">
          Everyone orders inside Radiues — one shared cart, one payment, split equally.
        </p>
        <Button onClick={create} disabled={busy} className="mt-4 w-full">
          Create &amp; get a code
        </Button>
      </Card>

      {/* Join existing */}
      <Card className="mt-4">
        <p className="text-[14px] font-bold text-ink">Join with a code</p>
        <div className="mt-3 flex items-end gap-2">
          <Input
            label="6-character code"
            placeholder="ABC123"
            value={code}
            onChange={(e) =>
              setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6))
            }
          />
          <Button
            size="md"
            variant="secondary"
            onClick={join}
            disabled={busy || code.length !== 6}
          >
            Join
          </Button>
        </div>
      </Card>

      {error && <p className="mt-3 text-[13px] text-danger">{error}</p>}
    </div>
  );
}
