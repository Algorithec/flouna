import type { Server } from "node:http";

/**
 * How long the API keeps an idle connection open, and how long it waits for a
 * request's headers.
 *
 * The web app reaches the API through its own proxy (the /api rewrites in
 * next.config.ts), and that proxy uses Node's shared connection pool, which
 * keeps idle connections for 5 seconds. Node's server closes idle ones after
 * 5 seconds by default (Node 24 adds a second's grace, so about 6). That
 * margin is too thin: when the web server is busy its 5 second cleanup runs
 * late, a request goes out on a connection the API has just closed, the proxy
 * gets ECONNRESET and the customer gets a 500 for a request the API never saw.
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
