import type { Server } from "node:http";

/**
 * How long the API keeps an idle connection open, and how long it waits for a
 * request's headers.
 *
 * The web app reaches the API through its own proxy (the /api rewrites in
 * next.config.ts), and that proxy uses Node's shared connection pool, which
 * keeps idle connections for 5 seconds. Node's server also closes idle ones
 * after 5 seconds by default. With both at 5 seconds, a request can go out on
 * a connection at the instant the API closes it: the proxy gets ECONNRESET
 * and the customer gets a 500 for a request the API never saw.
 *
 * Keeping idle connections well past the pool's 5 seconds means the proxy is
 * always the one to close first. Headers wait a little longer still, as Node
 * requires, or a slow request on a reused connection is cut off.
 */
export const KEEP_ALIVE_MS = 65_000;
export const HEADERS_TIMEOUT_MS = 66_000;

export function keepConnectionsAlive(server: Server) {
  server.keepAliveTimeout = KEEP_ALIVE_MS;
  server.headersTimeout = HEADERS_TIMEOUT_MS;
}
