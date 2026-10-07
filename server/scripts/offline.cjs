// Runs the API as if the network outside this machine were gone.
//
//   node --require ./scripts/offline.cjs --env-file=.env dist/index.js
//
// Every outbound request to a host other than this machine fails the way a
// venue network that lets nothing out fails: fetch rejects with
// "fetch failed", and http/https requests emit a connection error. Paired
// with `SMOKE_OFFLINE=1 npm run smoke` in web, it checks that each outside
// service (maps, geocoding, weather, models, payments, email) has a fallback
// that covers the call failing, not only the service answering badly.

const http = require("node:http");
const https = require("node:https");

const LOCAL = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const refused = new Map();

function isLocal(host) {
  return LOCAL.has(String(host || "").replace(/:\d+$/, ""));
}

function note(host) {
  refused.set(host, (refused.get(host) || 0) + 1);
  if (refused.get(host) === 1) console.warn(`[offline] refused ${host}`);
}

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (!isLocal(url.hostname)) {
    note(url.hostname);
    throw new TypeError("fetch failed", { cause: new Error("offline: outside network blocked") });
  }
  return realFetch(input, init);
};

for (const mod of [http, https]) {
  const real = mod.request;
  mod.request = function request(...args) {
    const first = args[0];
    const host =
      typeof first === "string" || first instanceof URL
        ? new URL(first).hostname
        : first?.hostname || first?.host;
    if (!isLocal(host)) {
      note(host);
      const req = new http.ClientRequest({ host: "127.0.0.1", port: 9, method: "GET", path: "/" });
      req.on("error", () => {});
      process.nextTick(() => req.destroy(Object.assign(new Error(`offline: ${host} blocked`), { code: "ENETUNREACH" })));
      return req;
    }
    return real.apply(this, args);
  };
  mod.get = function get(...args) {
    const req = mod.request(...args);
    req.end();
    return req;
  };
}

process.on("exit", () => {
  if (refused.size) {
    console.warn(`[offline] refused ${[...refused].map(([h, n]) => `${h} x${n}`).join(", ")}`);
  }
});
