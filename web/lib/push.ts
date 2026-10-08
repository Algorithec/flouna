// Browser-side Web Push helpers: register the service worker, subscribe the
// user, and tear down. All no-ops gracefully where push is unsupported.
import { api } from "./api";

function urlBase64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(normalized);
  // Allocate a plain ArrayBuffer-backed view so it satisfies BufferSource.
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

/**
 * Whether a subscription was made with this public key.
 *
 * A subscription is bound to the key it was made with. After the server's
 * keys are rotated, the old one can never receive a push, and the browser
 * refuses a new subscription with a different key while the old one exists,
 * so turning push back on failed with an error every time.
 */
function madeWithKey(sub: PushSubscription, publicKey: string): boolean {
  const have = sub.options.applicationServerKey;
  if (!have) return false;
  const a = new Uint8Array(have);
  const b = urlBase64ToBytes(publicKey);
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

async function serverKey(): Promise<string | null> {
  const { enabled, publicKey } = await api<{ enabled: boolean; publicKey: string | null }>(
    "/api/notifications/vapid",
  );
  return enabled && publicKey ? publicKey : null;
}

export function pushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

export async function getSubscriptionState(): Promise<
  "unsupported" | "denied" | "subscribed" | "default"
> {
  if (!pushSupported()) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return "default";
  // A subscription left over from before a key rotation receives nothing, so
  // it is not reported as on.
  const key = await serverKey().catch(() => null);
  return key && !madeWithKey(sub, key) ? "default" : "subscribed";
}

export async function enablePush(): Promise<
  "subscribed" | "denied" | "unsupported" | "unavailable"
> {
  if (!pushSupported()) return "unsupported";

  const publicKey = await serverKey();
  if (!publicKey) return "unavailable";

  const permission = await Notification.requestPermission();
  if (permission !== "granted") return "denied";

  const reg = await navigator.serviceWorker.register("/sw.js");
  await navigator.serviceWorker.ready;

  const existing = await reg.pushManager.getSubscription();
  if (existing && !madeWithKey(existing, publicKey)) await existing.unsubscribe();

  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToBytes(publicKey),
  });

  const json = sub.toJSON();
  await api("/api/notifications/subscribe", {
    method: "POST",
    json: { endpoint: sub.endpoint, keys: json.keys },
  });
  return "subscribed";
}

export async function disablePush(): Promise<void> {
  if (!pushSupported()) return;
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return;
  await api("/api/notifications/unsubscribe", {
    method: "POST",
    json: { endpoint: sub.endpoint },
  }).catch(() => {});
  await sub.unsubscribe().catch(() => {});
}
