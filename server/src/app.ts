import express from "express";
import helmet from "helmet";
import cors from "cors";
import cookieParser from "cookie-parser";
import rateLimit from "express-rate-limit";
import { env } from "./config/env.js";
import { prisma } from "./lib/prisma.js";
import { errorHandler, notFound } from "./middleware/error.js";
import { requireRole } from "./middleware/auth.js";
import { authRouter } from "./modules/auth/auth.routes.js";
import { chatRouter } from "./modules/chat/chat.routes.js";
import { foodRouter } from "./modules/food/food.routes.js";
import { cartRouter } from "./modules/cart/cart.routes.js";
import { ordersRouter } from "./modules/orders/orders.routes.js";
import { ridesRouter } from "./modules/rides/rides.routes.js";
import { paymentsRouter } from "./modules/payments/payments.routes.js";
import { usersRouter } from "./modules/users/users.routes.js";
import { notificationsRouter } from "./modules/notifications/notifications.routes.js";
import { groupsRouter } from "./modules/groups/groups.routes.js";
import { crewsRouter } from "./modules/groups/crews.routes.js";
import { alertsRouter } from "./modules/alerts/alerts.routes.js";
import { shopRouter } from "./modules/shop/shop.routes.js";
import { subscriptionRouter } from "./modules/subscription/subscription.routes.js";
import { couponsRouter } from "./modules/coupons/coupons.routes.js";
import { supportRouter } from "./modules/support/support.routes.js";
import { complianceRouter } from "./modules/compliance/compliance.routes.js";
import { complaintsRouter } from "./modules/complaints/complaints.routes.js";
import { igmWebhookRouter } from "./modules/complaints/igm.webhooks.js";
import { devRouter } from "./modules/backoffice/dev.routes.js";
import { adminRouter } from "./modules/backoffice/admin.routes.js";
import { superRouter } from "./modules/backoffice/super.routes.js";
import { requestKey } from "./middleware/rateLimit.js";
import { ondcRegistryRouter } from "./modules/ondc/registry.routes.js";
import { ondcCallbacksRouter } from "./modules/ondc/index.js";
import { ondcSearchRouter } from "./modules/ondc/search.routes.js";
import { ondcOrdersRouter } from "./modules/ondc/orders.routes.js";
import { ondcRidesRouter } from "./modules/ondc/rides.routes.js";
import { ondcMineRouter } from "./modules/ondc/mine.routes.js";
import { CALLBACK_ACTIONS, refused } from "./modules/ondc/callbacks.routes.js";
import { parseAuthorizationHeader } from "./modules/ondc/signing.js";
import { BUYER_ERRORS, nack } from "./modules/ondc/errors.js";

export function createApp() {
  const app = express();

  app.set("trust proxy", 1); // behind Cloudflare/nginx in production
  app.use(helmet());

  // Minimal structured request log (skipped in tests) — enough to debug
  // production incidents without a logging dependency.
  if (env.NODE_ENV !== "test") {
    app.use((req, res, next) => {
      const start = Date.now();
      res.on("finish", () => {
        console.log(
          JSON.stringify({
            t: new Date().toISOString(),
            m: req.method,
            p: req.path,
            s: res.statusCode,
            ms: Date.now() - start,
          }),
        );
      });
      next();
    });
  }
  app.use(
    cors({
      origin: env.WEB_ORIGIN,
      credentials: true,
    }),
  );
  // Keep the exact bytes — the Cashfree webhook HMAC is computed over them.
  const keepRawBody = (req: express.Request, _res: express.Response, buf: Buffer) => {
    (req as express.Request & { rawBody?: Buffer }).rawBody = buf;
  };
  const jsonBody = express.json({ limit: "100kb", verify: keepRawBody });

  // 100 KB is the right ceiling for the whole API and the wrong one for two
  // routes, and a parser mounted on a route cannot raise it: this one runs
  // first, for every request, and has already refused the body by the time
  // routing happens. Both routes were written as though it could.
  //
  //   complaint evidence — mounts its own 8 MB parser and documents the limit
  //     in a comment. Every photo a phone takes is larger than 100 KB, so
  //     attaching one to a complaint answered "That request was too large".
  //     The one piece of evidence a customer has for a cold delivery, refused.
  //
  //   encrypted chat history — its schema allows a 400 KB sealed payload for
  //     handing a conversation from one of your own devices to another. Under
  //     the ceiling no real handover ever fitted, so a second device could
  //     never be given the history the feature exists to give it.
  //
  // Decided here, where the ceiling actually is, and kept to these paths so
  // nothing else gains a bigger surface to be hammered with.
  const uploadJsonBody = express.json({ limit: "8mb", verify: keepRawBody });
  const bulkJsonBody = express.json({ limit: "600kb", verify: keepRawBody });
  const UPLOAD_PATHS = [/^\/api\/complaints\/[^/]+\/evidence\/?$/];
  const BULK_PATHS = [/^\/api\/groups\/[^/]+\/chat\/history\/?$/];
  // Seller apps answer a search with their whole catalogue in one on_search,
  // and a restaurant's menu with images and customisations runs to megabytes.
  // At 100 KB those answers were refused before their signature was checked.
  //
  // A body that size is only read for a request that at least carries a
  // well formed ONDC signature header, and behind its own per address limit
  // that runs before parsing: the general limiters below sit after the body
  // parser, so on their own they would let anyone make us parse 5 MB at will.
  // The registry handshake (on_subscribe) is unsigned and not covered here.
  const ondcJsonBody = express.json({ limit: "5mb", verify: keepRawBody });
  const ondcCallbackPaths = new Set(CALLBACK_ACTIONS.map((a) => `/ondc/${a}`));
  const isOndcCallback = (req: express.Request) =>
    req.method === "POST" && ondcCallbackPaths.has(req.path.replace(/\/+$/, ""));
  const ondcLimiter = rateLimit({
    windowMs: 60_000,
    limit: env.NODE_ENV === "test" ? 100_000 : 1_200,
    standardHeaders: false,
    legacyHeaders: false,
    keyGenerator: (req) => "ondc:" + (req.ip ?? ""),
    message: nack(BUYER_ERRORS.INTERNAL_ERROR, "Too many requests, retry shortly"),
  });
  app.use((req, res, next) => {
    if (!isOndcCallback(req)) return next();
    ondcLimiter(req, res, () => {
      if (!parseAuthorizationHeader(req.get("authorization") ?? "")) {
        refused(req.path.split("/").pop() ?? "callback", req.get("authorization"), "malformed signature header");
        res.status(401).json(nack(BUYER_ERRORS.INVALID_SIGNATURE, "Signature not accepted: malformed"));
        return;
      }
      ondcJsonBody(req, res, next);
    });
  });
  app.use((req, res, next) => {
    // Already parsed by the ONDC branch above.
    if (isOndcCallback(req)) return next();
    if (req.method === "POST") {
      if (UPLOAD_PATHS.some((re) => re.test(req.path))) {
        return uploadJsonBody(req, res, next);
      }
      if (BULK_PATHS.some((re) => re.test(req.path))) {
        return bulkJsonBody(req, res, next);
      }
    }
    return jsonBody(req, res, next);
  });
  app.use(cookieParser());

  // Two safety nets, because one is always wrong for somebody.
  //
  // The first counts a request against its SESSION. A single user with the
  // group cart and the chat open is already polling several times a minute
  // before they touch anything, so the per-person allowance has to be generous.
  //
  // The second counts against the ADDRESS, and is deliberately far higher. On
  // Indian mobile networks carrier-grade NAT puts thousands of subscribers
  // behind one public address; an address bucket sized for a person would
  // throttle an entire city block for the behaviour of one phone in it. Sized
  // like this it still stops a single machine hammering the API, without
  // punishing a crowd for sharing a carrier.
  //
  // Sensitive routes (OTP, login, chat) add their own much stricter limits on
  // top; these two only catch runaway traffic.
  app.use(
    rateLimit({
      windowMs: 60_000,
      limit: env.NODE_ENV === "test" ? 100_000 : 600,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      keyGenerator: requestKey,
      message: { error: "Too many requests. Slow down a moment." },
    }),
  );
  app.use(
    rateLimit({
      windowMs: 60_000,
      limit: env.NODE_ENV === "test" ? 100_000 : 3_000,
      standardHeaders: false,
      legacyHeaders: false,
      keyGenerator: (req) => "addr:" + (req.ip ?? ""),
      // Anonymous traffic only. A signed-in request is already bounded by the
      // per-session limiter above, so counting it against its address a second
      // time re-creates exactly the problem that limiter exists to solve: on a
      // carrier-NAT address, one bucket would have to hold thousands of
      // legitimate customers, and no number is both large enough for them and
      // small enough to stop an attacker. Anonymous requests can do very little
      // — login and sign-up carry their own far stricter limits — so an address
      // ceiling is the right shape for them and the wrong shape for everyone
      // who has already signed in.
      skip: (req) =>
        Boolean(
          (req as typeof req & { cookies?: Record<string, string> }).cookies
            ?.access_token,
        ),
      message: { error: "Too many requests from this network." },
    }),
  );

  // Liveness + readiness: verifies the process is up AND the database is
  // reachable. Uptime monitors and load balancers poll this.
  const healthHandler: express.RequestHandler = async (_req, res) => {
    const started = Date.now();
    try {
      // Two checks, because they fail separately and only one of them used to
      // be made. SELECT 1 proves the database is reachable; it proves nothing
      // about whether the schema was ever applied to it. A deployment pointed
      // at an empty Postgres answered "db: ok" here while every real query
      // threw — so uptime monitors read all-green while nobody could sign in.
      //
      // Counting a row from a table the app cannot work without closes that
      // gap. It is cheap, and it fails loudly the moment the schema is missing
      // or the client was generated for a different engine.
      await prisma.$queryRaw`SELECT 1`;
      await prisma.user.count();
      res.json({
        ok: true,
        service: "flouna-api",
        db: "ok",
        uptimeSeconds: Math.round(process.uptime()),
        latencyMs: Date.now() - started,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      // "unreachable" and "no schema" need different people doing different
      // things, and answering the same word for both sends whoever is on call
      // to check the wrong thing first.
      const reason = err instanceof Error ? err.message : String(err);
      const missingSchema =
        /does not exist|no such table|relation .* does not exist|P2021|P2022/i.test(reason);
      console.error("[health] database check failed:", reason);
      res.status(503).json({
        ok: false,
        service: "flouna-api",
        db: missingSchema ? "schema-missing" : "unreachable",
        hint: missingSchema
          ? "The database is reachable but has no schema. Run the deploy step that applies it."
          : "The database could not be reached. Check DATABASE_URL and the network path.",
        timestamp: new Date().toISOString(),
      });
    }
  };

  app.get(["/", "/health", "/api/health"], healthHandler);

  // At the root rather than under /api: the ONDC registry derives both URLs
  // from the subscriber id (ondc.flouna.com), so this is where it looks.
  app.use(ondcRegistryRouter);
  // Seller apps answer our requests here (on_search, on_select, ...), signed.
  app.use(ondcCallbacksRouter());
  app.use("/api/auth", authRouter);
  // Privacy rights and cookie choices (privacy policy 6, cookie policy 1.3).
  app.use("/api/privacy", complianceRouter);
  app.use("/api/chat", chatRouter);
  app.use("/api/food", foodRouter);
  app.use("/api/orders", ordersRouter);
  app.use("/api/ondc/search", ondcSearchRouter);
  app.use("/api/ondc/orders", ondcOrdersRouter);
  app.use("/api/ondc/rides", ondcRidesRouter);
  app.use("/api/ondc/mine", ondcMineRouter);
  app.use("/api/cart", cartRouter);
  app.use("/api/complaints", complaintsRouter);
  // ONDC network callbacks. Outside /api on purpose: no session, no cookies.
  app.use("/webhooks/ondc/igm", igmWebhookRouter);
  app.use("/api/rides", ridesRouter);
  app.use("/api/payments", paymentsRouter);
  app.use("/api/users", usersRouter);
  app.use("/api/notifications", notificationsRouter);
  app.use("/api/groups/crews", crewsRouter);
  app.use("/api/groups", groupsRouter);
  app.use("/api/alerts", alertsRouter);
  app.use("/api/shop", shopRouter);
  app.use("/api/subscription", subscriptionRouter);
  app.use("/api/coupons", couponsRouter);
  app.use("/api/support", supportRouter);

  // Back-office consoles (developer / admin / super-admin) under one namespace,
  // behind a tighter rate limit than the consumer API. The routers themselves
  // enforce RBAC; this is defense-in-depth against brute-forcing the surface.
  const consoleLimiter = rateLimit({
    windowMs: 60_000,
    limit: env.NODE_ENV === "test" ? 1000 : 60,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "Too many requests." },
  });
  app.use("/api/console", consoleLimiter);
  // Step-up-aware identity probe for the console UI: succeeds only for an
  // operator whose session has cleared 2FA. The guard returns 403
  // step_up_required (→ OTP screen) or 404 (→ not an operator) otherwise, so the
  // frontend can route correctly before rendering any console page.
  app.get(
    "/api/console/whoami",
    requireRole("developer", "admin", "super_admin"),
    async (req, res) => {
      res.json({ id: req.userId, role: req.userRole });
    },
  );
  app.use("/api/console/dev", devRouter);
  app.use("/api/console/admin", adminRouter);
  app.use("/api/console/super", superRouter);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
