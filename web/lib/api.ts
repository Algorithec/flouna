// Thin client for the Flouna API. All authenticated requests rely on
// httpOnly cookies (credentials: "include") — tokens are never stored in JS.
// NEXT_PUBLIC_API_URL="/" means same-origin: the host proxies /api/* to the
// API service (see next.config.ts rewrites) so cookies stay first-party.
import { dictionaries } from "@/lib/i18n/dictionaries";
import { savedLang } from "@/lib/i18n/lang";

const configured = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
/** Where API requests go: "" for same origin, else a full origin. For the few
    requests that cannot use api(), such as a file download. */
export const API_URL = configured === "/" ? "" : configured.replace(/\/$/, "");

export class ApiClientError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: unknown,
    // Server-provided error code (e.g. "step_up_required"), when present.
    public code?: string,
  ) {
    super(message);
  }
}

// Statuses at which a body without the API's `error` field means the request
// never reached the API: the host's "Application not found" while the service
// is stopped (404), the proxy failing to connect (500), a gateway giving up
// (502 to 504). Every error the API itself sends carries `error` (see the
// server's middleware/error.ts), so a 404 can go on meaning "does not exist".
const NOT_FROM_THE_API = new Set([404, 500, 502, 503, 504]);

/** What screens show when no answer came back from Flouna at all. */
function unreachable(): ApiClientError {
  const offline = typeof navigator !== "undefined" && navigator.onLine === false;
  const key = offline ? "common.offline" : "common.unavailable";
  return new ApiClientError(
    503,
    dictionaries[savedLang()][key] ?? dictionaries.en[key],
    undefined,
    offline ? "offline" : "unavailable",
  );
}

// One refresh at a time — parallel 401s share the same attempt instead of
// racing the rotating refresh token (which would log the user out).
let refreshInFlight: Promise<boolean> | null = null;

async function tryRefresh(): Promise<boolean> {
  refreshInFlight ??= fetch(`${API_URL}/api/auth/refresh`, {
    method: "POST",
    credentials: "include",
  })
    .then((r) => r.ok)
    .catch(() => false)
    .finally(() => {
      refreshInFlight = null;
    });
  return refreshInFlight;
}

async function rawFetch(path: string, options: RequestInit & { json?: unknown }) {
  const { json, headers, ...rest } = options;
  return fetch(`${API_URL}${path}`, {
    ...rest,
    credentials: "include",
    headers: {
      ...(json !== undefined ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
}

async function send(path: string, options: RequestInit & { json?: unknown }) {
  try {
    return await rawFetch(path, options);
  } catch (err) {
    // fetch rejects only when no response arrived: offline, a DNS failure, a
    // dropped connection. Left alone, the browser's own words for that
    // ("Failed to fetch") are what most screens print. A request the caller
    // cancelled stays a cancellation.
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw unreachable();
  }
}

export async function api<T>(
  path: string,
  options: RequestInit & { json?: unknown } = {},
): Promise<T> {
  let res = await send(path, options);

  // Access token expired mid-session: refresh once and retry transparently.
  if (res.status === 401 && !path.startsWith("/api/auth/")) {
    if (await tryRefresh()) {
      res = await send(path, options);
    }
  }

  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw failure(res.status, data);
  return data as T;
}

function failure(status: number, data: unknown): ApiClientError {
  const fromTheApi = typeof (data as { error?: unknown } | null)?.error === "string";
  if (!fromTheApi && NOT_FROM_THE_API.has(status)) return unreachable();
  return new ApiClientError(
    status,
    (data as { error?: string } | null)?.error ?? `Request failed (${status})`,
    (data as { details?: unknown } | null)?.details,
    (data as { code?: string } | null)?.code,
  );
}

/**
 * Saves a file the API sends, such as a console export, under `filename`. A
 * plain link to the file would skip the refresh api() does, so an operator
 * whose access token had just expired got a page of JSON instead of a file.
 */
export async function apiDownload(path: string, filename: string): Promise<void> {
  let res = await send(path, {});
  if (res.status === 401 && !path.startsWith("/api/auth/") && (await tryRefresh())) {
    res = await send(path, {});
  }
  if (!res.ok) throw failure(res.status, await res.json().catch(() => null));
  const url = URL.createObjectURL(await res.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Released once the browser has had time to start the download; revoking it
  // straight away can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
