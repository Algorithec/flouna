import http from "node:http";
import { describe, expect, it } from "vitest";
import { HEADERS_TIMEOUT_MS, KEEP_ALIVE_MS, keepConnectionsAlive } from "../src/lib/keepAlive.js";

// The web app's /api proxy uses Node's shared connection pool. If the API
// closed idle connections no later than that pool does, a request could go out
// on a connection the API was closing at that instant, and fail as a 500.
describe("keeping idle connections alive", () => {
  it("outlives the proxy's connection pool, with headers waiting longer still", () => {
    const poolIdleMs = Number(http.globalAgent.options.timeout ?? 5000);
    const server = http.createServer();
    keepConnectionsAlive(server);
    expect(server.keepAliveTimeout).toBe(KEEP_ALIVE_MS);
    expect(server.keepAliveTimeout).toBeGreaterThan(poolIdleMs * 10);
    expect(server.headersTimeout).toBe(HEADERS_TIMEOUT_MS);
    expect(server.headersTimeout).toBeGreaterThan(server.keepAliveTimeout);
  });

  it("reuses one connection across an idle gap Node's defaults would have closed", async () => {
    const server = http.createServer((_req, res) => res.end("ok"));
    keepConnectionsAlive(server);
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as { port: number }).port;
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    const sockets = new Set<unknown>();
    const get = () =>
      new Promise<number>((resolve, reject) => {
        const req = http.get({ port, agent }, (res) => {
          sockets.add(res.socket);
          res.resume();
          res.on("end", () => resolve(res.statusCode ?? 0));
        });
        req.on("error", reject);
      });
    try {
      expect(await get()).toBe(200);
      // Node closes an idle connection after its 5 second default plus a
      // 1 second margin. Past that, ours is still open and reused.
      await new Promise((r) => setTimeout(r, 7_000));
      expect(await get()).toBe(200);
      expect(sockets.size).toBe(1);
    } finally {
      agent.destroy();
      await new Promise((r) => server.close(r));
    }
  }, 20_000);
});
