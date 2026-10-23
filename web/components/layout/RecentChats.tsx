"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Archive, ArchiveRestore, ExternalLink, MessageSquare, MoreHorizontal, Pencil, Pin, PinOff, Trash2 } from "lucide-react";
import { api } from "@/lib/api";
import { cn } from "@/lib/cn";
import { useI18n } from "@/components/i18n/I18nContext";
import { useToast } from "@/components/ui/Toast";
import { useEscapeToClose } from "@/lib/useEscapeToClose";

// Recent chats in the sidebar, each with a menu of what can be done to it:
// open in a new tab, pin, rename, archive, delete. Right click opens it on a
// computer, a long press on a phone, and the "⋯" button on either. While it
// is open, its keys work too (P, R, A, D).

type Summary = { id: string; title: string | null; pinned: boolean; archived: boolean };
type MenuAt = { id: string; x: number; y: number; touch?: boolean };

const LONG_PRESS_MS = 500;

export function RecentChats({ onNavigate }: { onNavigate: () => void }) {
  const { t } = useI18n();
  const { toast } = useToast();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const openChat = pathname === "/home" ? searchParams.get("chat") : null;

  const [recent, setRecent] = useState<Summary[]>([]);
  const [archived, setArchived] = useState<Summary[] | null>(null);
  const [archivedCount, setArchivedCount] = useState(0);
  const [showAll, setShowAll] = useState(false);
  const [menu, setMenu] = useState<MenuAt | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Summary | null>(null);

  const load = useCallback(() => {
    api<{ sessions: Summary[]; archivedCount: number }>("/api/chat/sessions")
      .then((d) => {
        setRecent(d.sessions);
        setArchivedCount(d.archivedCount ?? 0);
      })
      .catch(() => setRecent([]));
  }, []);

  // Refreshed on navigation: a new chat changes the URL.
  useEffect(load, [load, pathname, searchParams]);

  const loadArchived = useCallback(() => {
    api<{ sessions: Summary[] }>("/api/chat/sessions?archived=1")
      .then((d) => setArchived(d.sessions))
      .catch(() => setArchived([]));
  }, []);

  const all = [...recent, ...(archived ?? [])];
  const find = (id: string) => all.find((s) => s.id === id);

  async function change(id: string, body: { pinned?: boolean; archived?: boolean; title?: string }) {
    try {
      await api(`/api/chat/sessions/${id}`, { method: "PATCH", json: body });
      if (body.archived) toast(t("cm.archivedToast"));
      load();
      // Refreshed only if it is open: archiving a chat should not unfold the list.
      if (archived !== null) loadArchived();
    } catch {
      toast(t("cm.failed"), "error");
    }
  }

  async function remove(id: string) {
    try {
      await api(`/api/chat/sessions/${id}`, { method: "DELETE" });
      toast(t("cm.deleted"));
      setDeleting(null);
      // Deleting the chat on screen leaves nothing to show: start a new one.
      if (openChat === id) router.replace("/home");
      load();
      if (archived !== null) loadArchived();
    } catch {
      toast(t("cm.failed"), "error");
    }
  }

  function act(action: "open" | "pin" | "rename" | "archive" | "delete", id: string) {
    const s = find(id);
    setMenu(null);
    if (!s) return;
    if (action === "open") window.open(`/home?chat=${id}`, "_blank", "noopener");
    if (action === "pin") void change(id, { pinned: !s.pinned });
    if (action === "rename") setRenaming(id);
    if (action === "archive") void change(id, { archived: !s.archived });
    if (action === "delete") setDeleting(s);
  }

  const visible = showAll ? recent : recent.slice(0, Math.max(5, recent.filter((s) => s.pinned).length));

  if (recent.length === 0 && archivedCount === 0) return null;

  return (
    <>
      {recent.length > 0 && (
        <p className="px-1 text-[13px] font-bold text-muted">{t("sb.recent")}</p>
      )}
      <div className="mt-2 flex flex-col gap-0.5">
        {visible.map((s) => (
          <ChatRow
            key={s.id}
            chat={s}
            active={openChat === s.id}
            renaming={renaming === s.id}
            onNavigate={onNavigate}
            onMenu={(x, y, touch) => setMenu({ id: s.id, x, y, touch })}
            onRename={(title) => {
              setRenaming(null);
              const next = title.trim();
              if (next && next !== (s.title ?? "")) void change(s.id, { title: next.slice(0, 80) });
            }}
          />
        ))}
        {recent.length > visible.length && (
          <button
            onClick={() => setShowAll(true)}
            className="tap-target px-3 py-2 text-left text-[13px] font-semibold text-accent hover:underline"
          >
            {t("sb.showAll")}
          </button>
        )}

        {archivedCount > 0 && (
          <button
            onClick={() => {
              if (archived === null) loadArchived();
              else setArchived(null);
            }}
            aria-expanded={archived !== null}
            className="tap-target mt-2 flex items-center gap-2 px-3 py-2 text-left text-[13px] font-semibold text-muted hover:text-ink"
          >
            <Archive size={14} className="shrink-0" />
            {archived === null ? `${t("cm.archived")} (${archivedCount})` : t("cm.hideArchived")}
          </button>
        )}
        {archived?.map((s) => (
          <ChatRow
            key={s.id}
            chat={s}
            active={openChat === s.id}
            renaming={renaming === s.id}
            onNavigate={onNavigate}
            onMenu={(x, y, touch) => setMenu({ id: s.id, x, y, touch })}
            onRename={(title) => {
              setRenaming(null);
              const next = title.trim();
              if (next && next !== (s.title ?? "")) void change(s.id, { title: next.slice(0, 80) });
            }}
          />
        ))}
      </div>

      {menu && find(menu.id) && (
        <ChatMenu at={menu} chat={find(menu.id)!} onAct={act} onClose={() => setMenu(null)} />
      )}
      {deleting && <DeleteConfirm chat={deleting} onCancel={() => setDeleting(null)} onDelete={() => remove(deleting.id)} />}
    </>
  );
}

function ChatRow({
  chat,
  active,
  renaming,
  onNavigate,
  onMenu,
  onRename,
}: {
  chat: Summary;
  active: boolean;
  renaming: boolean;
  onNavigate: () => void;
  onMenu: (x: number, y: number, touch?: boolean) => void;
  onRename: (title: string) => void;
}) {
  const { t } = useI18n();
  const press = useRef<{ timer: ReturnType<typeof setTimeout>; fired: boolean } | null>(null);
  const title = chat.title ?? t("sb.newChat");

  if (renaming) {
    return (
      <input
        autoFocus
        defaultValue={chat.title ?? ""}
        maxLength={80}
        aria-label={t("cm.renameLabel")}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={(e) => onRename(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") {
            e.stopPropagation();
            onRename("");
          }
        }}
        className="mx-1 rounded-[10px] border border-accent bg-card px-2.5 py-1.5 text-[14px] text-ink outline-none"
      />
    );
  }

  const cancelPress = () => {
    if (press.current) clearTimeout(press.current.timer);
  };

  return (
    <div
      className={cn(
        "group relative flex items-center rounded-[12px] transition-colors hover:bg-beige/50",
        active && "bg-beige/60",
      )}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(e.clientX, e.clientY);
      }}
    >
      <Link
        href={`/home?chat=${chat.id}`}
        onClick={(e) => {
          // A long press opened the menu; the finger lifting is not a tap.
          if (press.current?.fired) {
            e.preventDefault();
            press.current = null;
            return;
          }
          onNavigate();
        }}
        onTouchStart={(e) => {
          const touch = e.touches[0]!;
          const { clientX, clientY } = touch;
          const timer = setTimeout(() => {
            if (press.current) press.current.fired = true;
            navigator.vibrate?.(10);
            onMenu(clientX, clientY, true);
          }, LONG_PRESS_MS);
          press.current = { timer, fired: false };
        }}
        onTouchMove={cancelPress}
        onTouchEnd={cancelPress}
        // Keeps the phone's own link preview and text selection out of the way of the long press.
        style={{ WebkitTouchCallout: "none" }}
        className="tap-target flex min-w-0 flex-1 select-none items-center gap-2 py-2 pl-3 pr-1 text-[14px] text-ink/80"
      >
        {chat.pinned ? (
          <Pin size={14} className="shrink-0 text-accent" aria-label={t("cm.pinned")} />
        ) : (
          <MessageSquare size={14} className="shrink-0 text-muted" />
        )}
        <span className="truncate">{title}</span>
      </Link>
      <button
        aria-label={`${t("cm.options")}: ${title}`}
        aria-haspopup="menu"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          // Right-aligned under the button; the menu keeps itself on screen.
          onMenu(r.right - 220, r.bottom + 4);
        }}
        className={cn(
          "tap-target mr-1 flex size-7 shrink-0 items-center justify-center rounded-[8px] text-muted hover:bg-beige hover:text-ink",
          "opacity-0 focus-visible:opacity-100 group-hover:opacity-100",
          active && "opacity-100",
        )}
      >
        <MoreHorizontal size={16} />
      </button>
    </div>
  );
}

function ChatMenu({
  at,
  chat,
  onAct,
  onClose,
}: {
  at: MenuAt;
  chat: Summary;
  onAct: (action: "open" | "pin" | "rename" | "archive" | "delete", id: string) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: at.x, top: at.y });
  useEscapeToClose(true, onClose);

  // Opened by a long press, the finger is still down. When it lifts, the
  // browser sends a click to whatever is now under it, which is the menu's
  // backdrop, and the menu would close the moment it appeared. That one
  // click, arriving just after the lift, is swallowed; the next tap counts.
  useEffect(() => {
    if (!at.touch) return;
    // Only the first lift: every later tap is a choice and must go through.
    let liftedAt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      window.removeEventListener("touchend", onLift, true);
      window.removeEventListener("click", onClick, true);
      clearTimeout(timer);
    };
    function onLift() {
      liftedAt = Date.now();
      window.removeEventListener("touchend", onLift, true);
      // A phone that sends no click after a long press must not leave this
      // waiting to eat the next real tap.
      timer = setTimeout(stop, 400);
    }
    function onClick(e: MouseEvent) {
      if (liftedAt && Date.now() - liftedAt < 400) {
        e.preventDefault();
        e.stopPropagation();
      }
      stop();
    }
    window.addEventListener("touchend", onLift, true);
    window.addEventListener("click", onClick, true);
    return stop;
  }, [at.touch]);

  const items = [
    { key: "open" as const, label: t("cm.openNew"), icon: ExternalLink, shortcut: "" },
    { key: "pin" as const, label: chat.pinned ? t("cm.unpin") : t("cm.pin"), icon: chat.pinned ? PinOff : Pin, shortcut: "P" },
    { key: "rename" as const, label: t("cm.rename"), icon: Pencil, shortcut: "R" },
    { key: "archive" as const, label: chat.archived ? t("cm.unarchive") : t("cm.archive"), icon: chat.archived ? ArchiveRestore : Archive, shortcut: "A" },
    { key: "delete" as const, label: t("cm.delete"), icon: Trash2, shortcut: "D" },
  ];

  // Kept inside the window: a right click near the bottom or right edge
  // would otherwise open the menu half off screen.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    setPos({
      left: Math.max(8, Math.min(at.x, window.innerWidth - width - 8)),
      top: Math.max(8, Math.min(at.y, window.innerHeight - height - 8)),
    });
    el.querySelector<HTMLButtonElement>("[role=menuitem]")?.focus();
  }, [at.x, at.y]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const hit = items.find((i) => i.shortcut && i.shortcut === e.key.toUpperCase());
      if (hit && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        onAct(hit.key, chat.id);
        return;
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem]") ?? [])];
        const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next = e.key === "ArrowDown" ? (i + 1) % buttons.length : (i - 1 + buttons.length) % buttons.length;
        buttons[next]?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return createPortal(
    <div className="fixed inset-0 z-[60]" onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }}>
      <div
        ref={ref}
        role="menu"
        aria-label={t("cm.options")}
        onClick={(e) => e.stopPropagation()}
        style={{ left: pos.left, top: pos.top }}
        className="fixed w-[220px] rounded-[14px] border border-line bg-card p-1.5 shadow-lift"
      >
        {items.map((item, i) => (
          <div key={item.key}>
            {item.key === "archive" && <div className="mx-2 my-1 h-px bg-line" aria-hidden />}
            <button
              role="menuitem"
              onClick={() => onAct(item.key, chat.id)}
              className={cn(
                "flex w-full items-center gap-3 rounded-[10px] px-3 py-2 text-left text-[14px] outline-none hover:bg-beige/60 focus-visible:bg-beige/60",
                item.key === "delete" ? "text-danger" : "text-ink",
              )}
            >
              <item.icon size={16} className="shrink-0" />
              <span className="flex-1">{item.label}</span>
              {item.shortcut && <kbd className="font-sans text-[12px] text-muted">{item.shortcut}</kbd>}
            </button>
            {i === 0 && <div className="mx-2 my-1 h-px bg-line" aria-hidden />}
          </div>
        ))}
      </div>
    </div>,
    document.body,
  );
}

function DeleteConfirm({ chat, onCancel, onDelete }: { chat: Summary; onCancel: () => void; onDelete: () => Promise<void> }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  useEscapeToClose(!busy, onCancel);
  return createPortal(
    <div
      className="fixed inset-0 z-[70] flex items-end justify-center bg-black/40 sm:items-center sm:p-6"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="cm-delete-title"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onCancel();
      }}
    >
      <div className="w-full max-w-sm rounded-t-[32px] bg-auth-bg p-6 shadow-lift sm:rounded-[32px]">
        <p id="cm-delete-title" className="text-center text-[20px] font-bold text-ink">
          {t("cm.deleteTitle")}
        </p>
        <p className="mt-1 truncate text-center text-[14px] font-medium text-ink/80">{chat.title ?? t("sb.newChat")}</p>
        <p className="mx-auto mt-2 max-w-[300px] text-center text-[14px] text-cocoa">{t("cm.deleteBody")}</p>
        <div className="mt-5 flex gap-3">
          <button
            autoFocus
            onClick={onCancel}
            disabled={busy}
            className="tap-target flex-1 rounded-pill border border-line py-3 text-[15px] font-semibold text-ink disabled:opacity-50"
          >
            {t("cm.cancel")}
          </button>
          <button
            onClick={async () => {
              setBusy(true);
              await onDelete();
              setBusy(false);
            }}
            disabled={busy}
            className="tap-target flex-1 rounded-pill bg-danger py-3 text-[15px] font-bold text-white disabled:opacity-60"
          >
            {t("cm.delete")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
