"use client";

import { use, useCallback, useEffect, useRef, useState } from "react";
import { useEscapeToClose } from "@/lib/useEscapeToClose";
import { Send, Lock, ShieldAlert, Info, ShieldCheck, Smartphone, X } from "lucide-react";
import { api } from "@/lib/api";
import { GroupHeader } from "@/components/food/GroupHeader";
import type { GroupCart } from "@/components/food/GroupCartTypes";
import { useI18n } from "@/components/i18n/I18nContext";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/cn";
import {
  registerDevice,
  publishOwedChains,
  type KeysResponse,
} from "@/lib/groupChatSetup";
import {
  cryptoAvailable,
  ownChain,
  openDistribution,
  encryptMessage,
  rewindOwnChain,
  decryptMessage,
  loadChains,
  saveChains,
  loadLog,
  saveLog,
  sealHistory,
  openHistory,
  safetyNumber,
  type MemberDevice,
  type SenderChain,
  type LoggedMessage,
} from "@/lib/groupCrypto";

// Group chat on Sender Keys, the design Signal and WhatsApp use for groups.
//
// Each device owns a chain and hands it to every other member device once. On
// load this screen does four things in order: register its keys, publish its
// chain to anyone who lacks it, take in the chains published to it, and read.
//
// A message it cannot open is shown as such rather than hidden. A device let in
// today genuinely cannot read what was said yesterday — that is the forward
// secrecy working — and saying so is more honest than a gap in the conversation.
// The past reaches a new device by history sync from another device of the same
// user, which is how WhatsApp moves it too.

const POLL_MS = 3000;
// Keys change far less often than messages, but they do change: someone
// opens the app on a new phone and every other device has to notice.
const KEY_SYNC_MS = 9000;

type Wire = {
  id: string;
  senderId: string;
  senderName: string;
  senderDevice: string;
  index: number;
  version: number;
  isYou: boolean;
  iv: string;
  ciphertext: string;
  signature: string | null;
  createdAt: string;
};

type Shown = LoggedMessage & {
  isYou: boolean;
  problem?: "too-old" | "no-chain" | "forged" | "bad-key";
};

/** A message this device cannot open, rendered as such rather than hidden. */
function lockedRow(m: Wire, problem: NonNullable<Shown["problem"]>): Shown {
  return {
    id: m.id,
    senderId: m.senderId,
    senderName: m.senderName,
    senderDevice: m.senderDevice,
    text: "",
    verified: false,
    createdAt: m.createdAt,
    isYou: false,
    problem,
  };
}

export default function GroupChatPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const { t } = useI18n();
  const { toast } = useToast();
  const [cart, setCart] = useState<GroupCart | null>(null);
  const [messages, setMessages] = useState<Shown[]>([]);
  const [draft, setDraft] = useState("");
  const [state, setState] = useState<"setup" | "ready" | "unsupported" | "failed">("setup");
  const [sending, setSending] = useState(false);
  const [devices, setDevices] = useState<MemberDevice[]>([]);
  const [safety, setSafety] = useState("");
  const [showDevices, setShowDevices] = useState(false);
  useEscapeToClose(showDevices, () => setShowDevices(false));
  // Mirrored into state purely so the device list can render it: reading a ref
  // during render is exactly the tearing hazard React warns about.
  const [myDeviceId, setMyDeviceId] = useState("");

  // Chain state and the plaintext log live in refs: they are this device's
  // crypto state, not a rendering concern, and a re-render must never race a
  // ratchet forward.
  const chains = useRef<Map<string, SenderChain>>(new Map());
  const log = useRef<LoggedMessage[]>([]);
  /**
   * Messages this device could not open yet, kept so they can be retried when
   * their sender's chain arrives. Without this, a message that landed a moment
   * before its key stayed locked on screen forever: the poll cursor had already
   * moved past it and nothing ever fetched it again.
   */
  const pending = useRef<Wire[]>([]);
  const lastAt = useRef<string | null>(null);
  const bottom = useRef<HTMLDivElement | null>(null);
  const myDevice = useRef<string>("");

  useEffect(() => {
    api<GroupCart>(`/api/groups/${id}`).then(setCart).catch(() => {});
  }, [id]);

  /**
   * Publishes this device's chain to anyone who lacks it, takes in the chains
   * published to this device, and hands history to a sibling device that has
   * none. Runs on load and whenever the membership changes, because a new
   * member means new devices to seal for.
   */
  const syncKeys = useCallback(async () => {
    const me = myDevice.current;

    // 1. Hand this device's chain to everyone who lacks it — including this
    //    user's own other devices, which is what makes the account
    //    multi-device rather than one browser's private conversation.
    const keys: KeysResponse = await publishOwedChains(id, me);
    setDevices(keys.devices);
    setSafety(await safetyNumber(keys.devices));

    // 2. Take in the chains addressed to this device.
    let learned = false;
    for (const env of keys.inbound) {
      if (chains.current.has(env.senderDevice)) continue;
      const chain = await openDistribution(env);
      if (chain) {
        chains.current.set(env.senderDevice, chain);
        learned = true;
      }
    }
    if (learned) await saveChains(id, chains.current);

    // 3. If a sibling device sent history, take it — but never let it overwrite
    //    what this device has already read for itself.
    if (keys.history && log.current.length === 0) {
      const past = await openHistory(keys.history);
      if (past && past.length > 0) {
        log.current = past;
        setMessages(past.map((m) => ({ ...m, isYou: m.senderDevice === me })));
        lastAt.current = past[past.length - 1]!.createdAt;
        await saveLog(id, log.current);
        await api(`/api/groups/${id}/chat/history/${me}`, { method: "DELETE" }).catch(() => {});
      }
    }

    // 4. If another of this user's devices has no history and this one does,
    //    hand it over. Same user at both ends — nobody else should be able to
    //    give you a version of the conversation.
    if (log.current.length > 0) {
      const siblings = keys.devices.filter((d) => d.isYou && d.deviceId !== me);
      for (const sib of siblings) {
        const sealed = await sealHistory(log.current, sib);
        await api(`/api/groups/${id}/chat/history`, {
          method: "POST",
          json: { fromDevice: me, toDevice: sib.deviceId, ...sealed },
        }).catch(() => {});
      }
    }
  }, [id]);

  // ---- get into the room ----
  useEffect(() => {
    let cancelled = false;

    (async () => {
      if (!cryptoAvailable()) {
        setState("unsupported");
        return;
      }
      try {
        chains.current = await loadChains(id);
        log.current = await loadLog(id);
        await ownChain(id); // this device's chain must exist before publishing

        const me = await registerDevice();
        if (!me) {
          if (!cancelled) setState("unsupported");
          return;
        }
        myDevice.current = me;
        if (!cancelled) setMyDeviceId(me);

        if (!cancelled && log.current.length > 0) {
          setMessages(log.current.map((m) => ({ ...m, isYou: m.senderDevice === me })));
          lastAt.current = log.current[log.current.length - 1]!.createdAt;
        }

        await syncKeys();
        if (!cancelled) setState("ready");
      } catch {
        if (!cancelled) setState("failed");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [id, syncKeys]);

  // A new member brings new devices to seal for.
  const memberCount = cart?.members.length ?? 0;
  useEffect(() => {
    if (state !== "ready" || memberCount === 0) return;
    void syncKeys().catch(() => {});
  }, [memberCount, state, syncKeys]);

  // ---- read ----
  //
  // A device's chain may not have arrived when its messages do. Anything that
  // cannot be opened goes on a retry queue and is tried again after the next
  // key sync, in chain order, so a key that lands a second late still yields a
  // readable conversation instead of a permanent locked bubble.
  const drain = useCallback(
    async (incoming: Wire[]) => {
      const queue = [...pending.current, ...incoming].sort(
        (a, b) =>
          a.senderDevice.localeCompare(b.senderDevice) ||
          a.index - b.index ||
          a.createdAt.localeCompare(b.createdAt),
      );
      pending.current = [];

      let missingChain = false;
      const opened: LoggedMessage[] = [];
      const stuck: Shown[] = [];

      for (const m of queue) {
        // Our own messages went into the log when we sent them.
        if (m.senderDevice === myDevice.current) continue;
        if (log.current.some((l) => l.id === m.id)) continue;

        const res = await decryptMessage(chains.current, { cartId: id, ...m });
        if (res.ok) {
          opened.push({
            id: m.id,
            senderId: m.senderId,
            senderName: m.senderName,
            senderDevice: m.senderDevice,
            text: res.text,
            verified: res.verified,
            createdAt: m.createdAt,
          });
        } else if (res.reason === "no-chain") {
          // Keep it: the key may still be on its way.
          missingChain = true;
          pending.current.push(m);
          stuck.push(lockedRow(m, "no-chain"));
        } else {
          // too-old, bad-key and forged are final answers, not timing.
          stuck.push(lockedRow(m, res.reason));
        }
      }

      if (opened.length > 0) {
        log.current = [...log.current, ...opened].sort((a, b) =>
          a.createdAt.localeCompare(b.createdAt),
        );
        await saveLog(id, log.current);
        await saveChains(id, chains.current);
      }

      if (opened.length > 0 || stuck.length > 0) {
        // Rebuilt from the log plus whatever is still unreadable, so a message
        // that was locked a moment ago is REPLACED by its text rather than
        // leaving both versions on screen.
        const mine = myDevice.current;
        setMessages(
          [
            ...log.current.map((m) => ({ ...m, isYou: m.senderDevice === mine })),
            ...stuck,
          ].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
        );
      }

      return missingChain;
    },
    [id],
  );

  const poll = useCallback(async () => {
    if (state !== "ready") return;
    try {
      const since = lastAt.current ? `?after=${encodeURIComponent(lastAt.current)}` : "";
      const d = await api<{ messages: Wire[] }>(`/api/groups/${id}/chat/messages${since}`);
      if (d.messages.length > 0) {
        lastAt.current = d.messages[d.messages.length - 1]!.createdAt;
      }
      if (d.messages.length === 0 && pending.current.length === 0) return;

      const missingChain = await drain(d.messages);
      if (missingChain) {
        // Ask for the chain, then run the queue again with whatever arrived.
        await syncKeys().catch(() => {});
        await drain([]);
      }
    } catch {
      /* a dropped poll is not worth a banner */
    }
  }, [id, state, syncKeys, drain]);

  useEffect(() => {
    if (state !== "ready") return;
    const first = setTimeout(() => void poll(), 0);
    const timer = setInterval(() => void poll(), POLL_MS);
    // A device that appears later has to be sealed for, and its chain taken in.
    // Polling only for messages left both sides deaf to anyone who arrived
    // after this screen loaded.
    const keySync = setInterval(() => void syncKeys().catch(() => {}), KEY_SYNC_MS);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
      clearInterval(keySync);
    };
  }, [state, poll, syncKeys]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length]);

  async function send() {
    const text = draft.trim();
    if (!text || state !== "ready") return;
    setSending(true);
    // Seal for anyone new BEFORE advancing the chain. A distribution message
    // carries the chain's current position, so a device sealed for after this
    // send would be handed a position past this message and could never read
    // it — it would sit locked while everyone else saw it fine.
    await syncKeys().catch(() => {});
    const before = await ownChain(id);
    try {
      const built = await encryptMessage(id, text);
      const sent = await api<{ message: { id: string; createdAt: string } }>(
        `/api/groups/${id}/chat/messages`,
        {
          method: "POST",
          json: {
            senderDevice: myDevice.current,
            index: built.index,
            iv: built.iv,
            ciphertext: built.ciphertext,
            signature: built.signature,
          },
        },
      );
      const me = cart?.members.find((m) => m.isYou);
      const entry: LoggedMessage = {
        id: sent.message.id,
        senderId: me?.userId ?? "",
        senderName: me?.name ?? "",
        senderDevice: myDevice.current,
        text,
        verified: true,
        createdAt: sent.message.createdAt,
      };
      log.current.push(entry);
      await saveLog(id, log.current);
      setMessages((prev) => [...prev, { ...entry, isYou: true }]);
      lastAt.current = sent.message.createdAt;
      setDraft("");
    } catch (e) {
      // The chain advanced when the message was built. If it never reached the
      // server, put it back — otherwise this device skips a position and every
      // recipient stalls waiting for an index that will never arrive.
      await rewindOwnChain(id, before);
      toast(e instanceof Error ? e.message : t("chat.sendFailed"));
    } finally {
      setSending(false);
    }
  }

  const myDeviceCount = devices.filter((d) => d.isYou).length;

  return (
    <div className="mx-auto flex h-[calc(100dvh-4rem)] w-full max-w-xl flex-col px-4 lg:max-w-2xl lg:px-6">
      <GroupHeader
        title={cart?.name ?? t("chat.groupChat")}
        subtitle={t("chat.membersCount").replace("{n}", String(memberCount))}
        backTo={`/food/group/${id}`}
        right={
          <button
            onClick={() => setShowDevices(true)}
            aria-label={t("chat.securityInfo")}
            className="tap-target flex size-9 items-center justify-center rounded-full bg-success/10 transition-colors hover:bg-success/20"
          >
            <Lock size={16} className="text-success" />
          </button>
        }
      />

      <button
        onClick={() => setShowDevices(true)}
        className="mb-3 flex w-full items-start gap-2 rounded-[14px] bg-success/8 px-3 py-2.5 text-left transition-colors hover:bg-success/12"
      >
        <Lock size={13} className="mt-0.5 shrink-0 text-success" />
        <p className="text-[11px] leading-relaxed text-success">{t("chat.e2eeNotice")}</p>
      </button>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {state === "unsupported" && (
          <Notice icon={<ShieldAlert size={15} />} tone="warning">
            {t("chat.unsupported")}
          </Notice>
        )}
        {state === "failed" && (
          <Notice icon={<ShieldAlert size={15} />} tone="danger">
            {t("chat.setupFailed")}
          </Notice>
        )}
        {state === "setup" && (
          <Notice icon={<Info size={15} />} tone="muted">
            {t("chat.settingUp")}
          </Notice>
        )}

        {state === "ready" && messages.length === 0 && (
          <p className="py-10 text-center text-[13px] text-cocoa">{t("chat.noMessages")}</p>
        )}

        <div className="flex flex-col gap-2.5 pb-3">
          {messages.map((m) => (
            <div
              key={m.id}
              className={cn("flex flex-col", m.isYou ? "items-end" : "items-start")}
            >
              {!m.isYou && (
                <span className="mb-0.5 px-1 text-[11px] font-semibold text-cocoa">
                  {m.senderName}
                </span>
              )}
              <span
                className={cn(
                  "max-w-[80%] rounded-[16px] px-3.5 py-2 text-[14px] leading-relaxed",
                  m.isYou
                    ? "rounded-br-[6px] bg-accent text-white"
                    : "rounded-bl-[6px] bg-card text-ink shadow-soft",
                  m.problem && "italic opacity-70",
                  m.problem === "forged" && "bg-danger-soft text-danger opacity-100 not-italic",
                )}
              >
                {m.problem ? (
                  <span className="flex items-center gap-1.5">
                    {m.problem === "forged" ? <ShieldAlert size={12} /> : <Lock size={12} />}
                    {m.problem === "forged"
                      ? t("chat.notAuthentic")
                      : m.problem === "no-chain"
                        ? t("chat.waitingForKey")
                        : t("chat.cannotRead")}
                  </span>
                ) : (
                  m.text
                )}
              </span>
              <span className="mt-0.5 px-1 text-[10px] text-cocoa/70">
                {new Date(m.createdAt).toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </span>
            </div>
          ))}
          <div ref={bottom} />
        </div>
      </div>

      <div className="sticky bottom-0 flex items-center gap-2 bg-cream py-3">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value.slice(0, 2000))}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          disabled={state !== "ready"}
          placeholder={state === "ready" ? t("chat.typeMessage") : t("chat.notReady")}
          className="h-[46px] min-w-0 flex-1 rounded-pill border border-line bg-card px-4 text-[14px] text-ink outline-none focus:border-accent disabled:opacity-60"
        />
        <button
          onClick={send}
          disabled={state !== "ready" || sending || draft.trim().length === 0}
          aria-label={t("common.send")}
          className="tap-target flex size-[46px] shrink-0 items-center justify-center rounded-full bg-accent text-white transition-opacity hover:opacity-90 disabled:opacity-45"
        >
          <Send size={18} />
        </button>
      </div>

      {/* The device list and the safety number. The server decides which
          devices exist, so this is the screen that makes a change visible. */}
      {showDevices && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 lg:items-center"
          onClick={() => setShowDevices(false)}
        >
          <div
            role="dialog"
            aria-label={t("chat.securityInfo")}
            onClick={(e) => e.stopPropagation()}
            className="max-h-[80dvh] w-full max-w-md overflow-y-auto rounded-t-3xl bg-card p-5 lg:rounded-3xl"
          >
            <div className="flex items-center justify-between">
              <p className="flex items-center gap-2 text-[16px] font-bold text-ink">
                <ShieldCheck size={17} className="text-success" /> {t("chat.securityInfo")}
              </p>
              <button
                onClick={() => setShowDevices(false)}
                aria-label={t("common.close")}
                className="rounded-full p-1.5 text-cocoa hover:bg-beige/50"
              >
                <X size={18} />
              </button>
            </div>

            <p className="mt-3 text-[12px] leading-relaxed text-cocoa">
              {t("chat.safetyExplain")}
            </p>
            <p className="mt-2 rounded-[14px] bg-cream px-3 py-2.5 text-center font-mono text-[15px] font-bold tracking-wide text-ink">
              {safety || "…"}
            </p>

            <p className="mt-4 text-[13px] font-bold text-ink">
              {t("chat.devicesInChat").replace("{n}", String(devices.length))}
            </p>
            <div className="mt-2 flex flex-col gap-2">
              {devices.map((d) => (
                <div
                  key={`${d.userId}:${d.deviceId}`}
                  className="flex items-center gap-2.5 rounded-[14px] border border-line px-3 py-2"
                >
                  <Smartphone size={15} className="shrink-0 text-cocoa" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-semibold text-ink">
                      {d.name ?? t("chat.member")}
                    </span>
                    <span className="block truncate font-mono text-[10px] text-cocoa">
                      {d.deviceId.slice(0, 12)}
                    </span>
                  </span>
                  {d.isYou && myDeviceCount >= 1 && (
                    <span className="shrink-0 rounded-pill bg-accent-soft px-2 py-0.5 text-[10px] font-bold text-accent-ink">
                      {d.deviceId === myDeviceId
                        ? t("chat.thisDevice")
                        : t("chat.yourOther")}
                    </span>
                  )}
                </div>
              ))}
            </div>

            <p className="mt-4 text-[11px] leading-relaxed text-cocoa">
              {t("chat.limitNotice")}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

function Notice({
  icon,
  tone,
  children,
}: {
  icon: React.ReactNode;
  tone: "warning" | "danger" | "muted";
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-[14px] px-3.5 py-3 text-[12px] leading-relaxed",
        tone === "warning" && "bg-warning/10 text-warning",
        tone === "danger" && "bg-danger-soft text-danger",
        tone === "muted" && "bg-card text-cocoa shadow-soft",
      )}
    >
      <span className="mt-0.5 shrink-0">{icon}</span>
      <p>{children}</p>
    </div>
  );
}
