import { z } from "zod";
import { subscriberIdProblem, workbenchUrlProblem } from "../modules/ondc/context.js";
import { commercialTerms } from "../modules/ondc/commercial.js";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(4000),
  DATABASE_URL: z.string().min(1),
  // Which engine the schema is generated against. The build script reads this
  // too; it is declared here so the boot-time schema sync can tell a deployed
  // Postgres from local SQLite without guessing.
  DB_PROVIDER: z.enum(["sqlite", "postgresql"]).optional(),
  // An escape hatch for the case where the schema must be applied by hand —
  // a destructive change under review, say — and the app still has to start.
  SKIP_SCHEMA_SYNC: z.enum(["0", "1"]).optional(),
  WEB_ORIGIN: z.string().url().default("http://localhost:3000"),
  // Root for uploaded complaint evidence. Relative paths resolve from the
  // server working directory. Tests point this at a temp dir so a run never
  // writes into the working tree.
  UPLOAD_DIR: z.string().default("uploads"),

  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  ACCESS_TOKEN_TTL: z.string().default("15m"),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().default(30),

  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),

  // Email OTP — in development, leave SMTP unset and codes are printed to the console.
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  MAIL_FROM: z.string().default("Flouna <no-reply@flouna.app>"),
  // Brevo over HTTPS, preferred over SMTP wherever it is set.
  //
  // Railway — like most managed hosts — blocks outbound SMTP on every port as
  // an anti-abuse measure, so nodemailer could only ever time out there: every
  // verification code, reset code and receipt failed, and the reset screen
  // answered "Internal server error" to the people least able to act on it.
  // This is the same provider reached over 443, which nothing blocks.
  BREVO_API_KEY: z.string().optional(),

  // LLM providers — hybrid setup (Claude / Gemini / DeepSeek). Chat falls back
  // to a scripted demo mode if the selected provider's key is unset.
  LLM_PROVIDER: z
    .enum(["anthropic", "google", "deepseek", "nvidia", "ollama", "self_hosted", "demo"])
    .default("demo"),

  // A model we run ourselves, over an OpenAI-compatible endpoint. Left unset
  // everywhere it is not running, which is what keeps it out of the fallback
  // chain rather than adding a guaranteed timeout to every request.
  SELF_HOSTED_LLM_URL: z.string().url().optional(),
  SELF_HOSTED_LLM_MODEL: z.string().default("Qwen/Qwen3.5-9B"),
  // vLLM enforces a key only when started with --api-key.
  SELF_HOSTED_LLM_API_KEY: z.string().optional(),
  // Higher than the hosted providers' 20s: a self-hosted server can be cold,
  // and a first request that arrives while weights are still loading is worth
  // waiting a little longer for than a warm API is.
  SELF_HOSTED_LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  // How long one hosted model attempt may take before chat falls through to
  // the next provider. A customer is waiting on it, so seconds, not tens.
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(4000),
  ANTHROPIC_API_KEY: z.string().optional(),
  DEEPSEEK_API_KEY: z.string().optional(),
  NVIDIA_API_KEY: z.string().optional(),
  OLLAMA_URL: z.string().url().optional(),
  OLLAMA_MODEL: z.string().optional(),
  // Sent as a Bearer token. Ollama checks nothing itself, so a model server
  // on the internet sits behind a reverse proxy (Caddy) that checks this.
  OLLAMA_API_KEY: z.string().optional(),
  // A model run beside the one that answers, measured and never shown (see
  // chat/llm/watcher.ts). Off unless set. It is kept out of the customer
  // facing chain, so a model under evaluation can never answer anyone.
  // Empty means off, so a copied .env.example with "LLM_WATCHER=" still boots.
  LLM_WATCHER: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.enum(["anthropic", "google", "deepseek", "nvidia", "ollama", "self_hosted"]).optional(),
  ),
  // Share of chat messages the watcher reads, 0 to 1.
  LLM_WATCHER_SAMPLE: z.coerce.number().min(0).max(1).default(1),
  // Rules answer the messages they read cleanly; only doubtful ones wait for
  // a model. Off unless set to "true": z.coerce.boolean reads "false" as true,
  // and a flag that changes who answers customers must not turn on by typo.
  HYBRID_ROUTING: z.preprocess((v) => v === "true" || v === "1", z.boolean()),
  // Google AI Studio (Gemini). Free-tier friendly; model is overridable.
  GOOGLE_AI_API_KEY: z.string().optional(),
  GOOGLE_AI_MODEL: z.string().default("gemini-2.0-flash"),

  // Cashfree sandbox
  CASHFREE_APP_ID: z.string().optional(),
  CASHFREE_SECRET_KEY: z.string().optional(),
  CASHFREE_ENV: z.enum(["sandbox", "production"]).default("sandbox"),
  CASHFREE_RETURN_ORIGIN: z.string().url().optional(),

  // Maps
  GEOAPIFY_KEY: z.string().optional(),
  ORS_KEY: z.string().optional(),
  // Google Maps Platform, server side: Routes and Places. Restrict this key
  // to those APIs. Google's terms forbid showing its routes or places on a
  // non-Google map, so set it only alongside the web's Google map key.
  GOOGLE_MAPS_API_KEY: z.string().optional(),
  // Weather (context engine). Open-Meteo is keyless, so weather-aware advice
  // works without this; the key only switches to a paid provider if set later.
  WEATHER_API_KEY: z.string().optional(),

  // Web push (VAPID). Generate with: npx web-push generate-vapid-keys
  // Public key is also exposed to the browser as NEXT_PUBLIC_VAPID_PUBLIC_KEY.
  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  VAPID_SUBJECT: z.string().default("mailto:support@flouna.app"),

  // Fulfilment provider. "simulation" runs the full booking/tracking flow with
  // a simulated captain + driver GPS (works with no third-party access).
  // "ondc" switches to the real ONDC mobility adapter — requires the network
  // credentials below (your registered Buyer App). Flip this once onboarded.
  PROVIDER_MODE: z.enum(["simulation", "ondc"]).default("simulation"),
  // Deliberate opt-in to run a production pilot on simulated fulfilment before
  // ONDC onboarding completes. The gate below still refuses without it, and the
  // app labels itself a demo to users when it is on. Never set this quietly:
  // the whole point of the gate is that nobody is shown a driver who does not
  // exist without being told.
  ALLOW_SIMULATED_FULFILMENT: z
    .string()
    .optional()
    .transform((v) => v === "true"),
  ONDC_BASE_URL: z.string().url().optional(), // Buyer App gateway endpoint
  ONDC_SUBSCRIBER_ID: z.string().optional(),
  ONDC_SIGNING_PRIVATE_KEY: z.string().optional(),
  ONDC_SIGNING_PUBLIC_KEY: z.string().optional(),
  // The X25519 half of the key file the ONDC portal issues. Only used to
  // answer the registry's on_subscribe challenge.
  ONDC_ENCRYPTION_PRIVATE_KEY: z.string().optional(),
  // Which registry is talking to us, which decides the public key its
  // challenge is encrypted against. Pre-production until go-live.
  ONDC_REGISTRY_ENV: z.enum(["preprod", "prod"]).default("preprod"),
  // The id ondc-site-verification.html carries, signed. Any unique value; the
  // same one has to go in the subscribe request when we send it ourselves.
  ONDC_SITE_REQUEST_ID: z.string().optional(),
  // The unique key id ONDC issued with the signing key above. Together they
  // identify us on every signed message and registry lookup.
  ONDC_UNIQUE_KEY_ID: z.string().optional(),
  // ONDC registers each domain with its own key pair. The two above sign food
  // (ONDC:RET11) and everything that is not a ride; these sign ride messages
  // (ONDC:TRV10) when set, as the TRV10 entry in the registry expects. Set
  // together. See ondc/identity.ts.
  ONDC_UNIQUE_KEY_ID_TRV10: z.string().optional(),
  ONDC_SIGNING_PRIVATE_KEY_TRV10: z.string().optional(),
  // Network Observability tokens from the ONDC portal, one per business
  // profile. Unset, nothing is logged to ONDC for that profile.
  ONDC_NO_TOKEN_RETAIL: z.string().optional(),
  ONDC_NO_TOKEN_RIDE: z.string().optional(),
  // Whether chat searches ONDC sellers alongside its own picks. Off by
  // default: while registered on pre-production the sellers that answer are
  // test stores, which real customers must not be offered.
  ONDC_SEARCH_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === "true"),
  // Accounts that search ONDC sellers even while it is off for everyone else,
  // comma separated emails. Lets the team test against ONDC's pre-production
  // network from the live app without customers being shown its test stores.
  ONDC_SEARCH_TESTERS: z
    .string()
    .optional()
    .transform((v) => new Set((v ?? "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean))),
  // ONDC's workbench, https://workbench.ondc.tech/api-service, for running its
  // test flows from the live app: the testers above search its mock seller
  // instead of the gateway. Pre-production only; see modules/ondc/workbench.ts.
  ONDC_WORKBENCH_URL: z.string().optional(),
  // Commercial terms on ONDC, the founder's to set. Read and checked by
  // modules/ondc/commercial.ts, which explains each and its default.
  ONDC_FOOD_PAYMENT_COLLECTOR: z.string().optional(),
  ONDC_FINDER_FEE_PERCENT: z.string().optional(),
  ONDC_SETTLEMENT_ACCOUNT_NUMBER: z.string().optional(),
  ONDC_SETTLEMENT_IFSC: z.string().optional(),
  ONDC_SETTLEMENT_UPI: z.string().optional(),
  ONDC_SETTLEMENT_BENEFICIARY: z.string().optional(),
  ONDC_STATIC_TERMS_URL: z.string().optional(),
  ONDC_STATIC_TERMS_EFFECTIVE_DATE: z.string().optional(), // YYYY-MM-DD, set with ONDC_STATIC_TERMS_URL
  ONDC_BAP_GSTIN: z.string().optional(), // Algorithec's GSTIN, carried on every food confirm
  // The settlement agency (NBBL's NOCS), from its onboarding. Set together.
  ONDC_SETTLEMENT_AGENCY_ID: z.string().optional(),
  ONDC_SETTLEMENT_AGENCY_URL: z.string().optional(),

  // ₹50/month premium tier. Reuses the Cashfree gateway for the recurring
  // charge; falls back to a simulated activation in dev when unset.
  SUBSCRIPTION_PRICE_PAISE: z.coerce.number().default(5000),

  // Error monitoring (Sentry). Optional — when unset, monitoring is a no-op
  // and errors are logged to the console as today.
  SENTRY_DSN: z.string().optional(),

  /**
   * Complete payments inside the app instead of handing off to the gateway.
   *
   * For demos and pitches. A real checkout redirects to Cashfree, which means
   * leaving the product on somebody else's page, over whatever network the
   * room has, at the exact moment the story is about money. This keeps the
   * whole flow in Flouna and offline.
   *
   * Refused outright in production below, whatever this says: it marks orders
   * paid without taking any.
   */
  DEMO_PAYMENTS: z.coerce.boolean().default(false),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid environment configuration:");
  for (const issue of parsed.error.issues) {
    console.error(`  ${issue.path.join(".")}: ${issue.message}`);
  }
  process.exit(1);
}

export const env = parsed.data;
export const isProd = env.NODE_ENV === "production";

// Production safety gate: refuse to boot with a dev-grade configuration in
// production, so we never accidentally ship with weak secrets or a dev database.
if (isProd) {
  if (env.DEMO_PAYMENTS) {
    throw new Error(
      "DEMO_PAYMENTS cannot be enabled in production: it marks orders paid without taking money.",
    );
  }
  const problems: string[] = [];
  if (env.DATABASE_URL.startsWith("file:")) {
    problems.push("DATABASE_URL points at a local SQLite file, use PostgreSQL in production");
  }
  if (env.JWT_ACCESS_SECRET.length < 48) {
    problems.push("JWT_ACCESS_SECRET is too short for production (use 48+ random chars)");
  }
  if (env.JWT_REFRESH_SECRET.length < 48) {
    problems.push("JWT_REFRESH_SECRET is too short for production (use 48+ random chars)");
  }
  if (!env.WEB_ORIGIN.startsWith("https://")) {
    problems.push("WEB_ORIGIN must be https:// in production (secure cookies require it)");
  }
  // The simulation adapter runs the whole booking flow — it invents a captain,
  // an OTP and a moving vehicle. That is exactly right in development and
  // indefensible in production, where a rider would be shown a driver who does
  // not exist. Nothing downstream can tell the difference, so the gate is here.
  if (env.PROVIDER_MODE === "simulation" && !env.ALLOW_SIMULATED_FULFILMENT) {
    problems.push(
      "PROVIDER_MODE=simulation fabricates drivers, OTPs and live tracking " +
        "set PROVIDER_MODE=ondc with ONDC_* credentials before serving real riders. " +
        "For a pilot on simulated fulfilment, set ALLOW_SIMULATED_FULFILMENT=true " +
        "the app then tells users it is a demo.",
    );
  }
  const subscriberProblem = subscriberIdProblem(env.ONDC_SUBSCRIBER_ID);
  if (subscriberProblem) problems.push(subscriberProblem);
  const workbenchProblem = workbenchUrlProblem(env.ONDC_WORKBENCH_URL);
  if (workbenchProblem) problems.push(workbenchProblem);
  if (env.ONDC_WORKBENCH_URL && env.ONDC_REGISTRY_ENV === "prod") {
    problems.push("ONDC_WORKBENCH_URL is a pre-production tool, unset it with ONDC_REGISTRY_ENV=prod");
  }
  // A term set to something that cannot go on the wire stops the server: it
  // would otherwise fail on the first order, in front of a customer.
  let ondcTerms: ReturnType<typeof commercialTerms> | null = null;
  try {
    ondcTerms = commercialTerms(process.env);
  } catch (err) {
    problems.push((err as Error).message);
  }
  if (Boolean(env.ONDC_UNIQUE_KEY_ID_TRV10) !== Boolean(env.ONDC_SIGNING_PRIVATE_KEY_TRV10)) {
    problems.push("ONDC_UNIQUE_KEY_ID_TRV10 and ONDC_SIGNING_PRIVATE_KEY_TRV10 are set together: one without the other signs ride messages with a key ONDC does not have");
  }
  if (env.PROVIDER_MODE === "ondc" && !env.ONDC_SUBSCRIBER_ID) {
    problems.push("PROVIDER_MODE=ondc but ONDC_SUBSCRIBER_ID is unset, the adapter cannot sign requests");
  }
  // Simulated payments are refused in production (see payments routes), so
  // without gateway credentials checkout has nowhere to go: the user reaches
  // the payment step and cannot complete it. Fail at boot instead.
  if (!env.CASHFREE_APP_ID || !env.CASHFREE_SECRET_KEY) {
    problems.push(
      "CASHFREE_APP_ID/CASHFREE_SECRET_KEY are unset, simulated payment is disabled " +
        "in production, so checkout would dead-end with no way to pay",
    );
  }
  // Every way into an account runs through an emailed code: sign-up, a new
  // device under two-factor, a password reset, the console's step-up. With no
  // transport those codes reach nobody, and the development fallback of
  // printing them would put them in the server log, readable by whoever can
  // read the logs. Fail at boot instead, as for payments.
  if (!env.BREVO_API_KEY && !(env.SMTP_HOST && env.SMTP_PORT)) {
    problems.push(
      "No mail transport is configured (BREVO_API_KEY, or SMTP_HOST and SMTP_PORT), " +
        "so sign-up, two-factor, reset and step-up codes could not be delivered",
    );
  }
  if (problems.length > 0) {
    console.error("Refusing to start: unsafe production configuration:");
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }

  // Degraded but honest: worth saying out loud at boot, not worth refusing to
  // start over. Each leaves a real feature quietly switched off.
  const warnings: string[] = [];
  if (env.ALLOW_SIMULATED_FULFILMENT) {
    warnings.push(
      "ALLOW_SIMULATED_FULFILMENT=true, rides are SIMULATED. No real driver is " +
        "dispatched. The app shows a demo notice; do not remove it.",
    );
  }
  if (env.LLM_PROVIDER === "demo") {
    warnings.push("LLM_PROVIDER=demo, chat runs on the rule-based engine, not a model");
  }
  if (env.CASHFREE_ENV === "sandbox") {
    warnings.push("CASHFREE_ENV=sandbox, payments are not real money");
  }
  // A token sent over plain http to another machine is readable by anyone on
  // the path, which is the whole of the internet between Railway and the VM.
  if (env.OLLAMA_API_KEY && env.OLLAMA_URL && isPlainHttpRemote(env.OLLAMA_URL)) {
    warnings.push(
      "OLLAMA_URL is plain http to a remote host, so OLLAMA_API_KEY travels unencrypted. " +
        "Serve the model through HTTPS (Caddy does this automatically).",
    );
  }
  if (!env.VAPID_PUBLIC_KEY) {
    warnings.push("VAPID_PUBLIC_KEY unset, web push notifications are disabled");
  }
  // Only worth saying once this deployment actually speaks ONDC.
  if (env.ONDC_SUBSCRIBER_ID && ondcTerms) {
    for (const u of ondcTerms.unconfirmed) warnings.push(`${u} (founder decision pending)`);
  }
  if (warnings.length > 0) {
    console.warn("Starting with reduced functionality:");
    for (const w of warnings) console.warn(`  - ${w}`);
  }
}

/** True for http:// to anything other than this machine. */
export function isPlainHttpRemote(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]", "::1"].includes(u.hostname);
  } catch {
    return false;
  }
}
