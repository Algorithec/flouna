import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { env, isProd } from "../config/env.js";

const run = promisify(execFile);

// Applying the schema before the server accepts a request.
//
// This exists because nothing else was doing it. The deploy ran build, generate
// and compile, and no migration in any phase — so the production database sat
// frozen at whatever schema someone last applied by hand, and every column added
// afterwards broke it. The symptom was brutal and misleading: login returned 500
// even for a WRONG password, because the lookup that should answer 401 selected
// a column the database did not have and threw before it could compare anything.
//
// It runs here, in the process, rather than as a platform pre-deploy hook,
// because the hook is configured in a dashboard this repository cannot see —
// a railway.json committed alongside it was silently overridden. Code is the one
// place the behaviour cannot be lost by a setting somebody forgot to carry
// across, and it works the same on any host.
//
// `db push` rather than `migrate deploy`: the migration history was generated
// against SQLite and its PRAGMA and DATETIME statements are rejected by
// Postgres, so it cannot be replayed there. Push diffs the live database
// against schema.prisma and applies the difference.
//
// Deliberately WITHOUT --accept-data-loss by default. Anything destructive
// fails, loudly, and the process exits rather than starting up having quietly
// dropped a column of real customer data.
//
// ACCEPT_SCHEMA_DATA_LOSS=1 is the escape hatch for a deploy that has already
// been reviewed and is known to be additive-only despite Prisma's classifier
// flagging it (e.g. a new unique index on a column with no rows yet). It is a
// one-deploy decision, not a standing setting — unset it again once applied.

const TIMEOUT_MS = 120_000;

/** True when the schema should be applied at boot rather than by hand. */
export function shouldSync(): boolean {
  if (env.SKIP_SCHEMA_SYNC === "1") return false;
  // Local development uses SQLite and its own migrate flow; this is for the
  // deployed Postgres, where nothing else runs.
  return isProd && env.DB_PROVIDER === "postgresql";
}

/**
 * Brings the database up to the schema. Resolves when it is safe to serve, and
 * rejects when it is not — the caller is expected to refuse to start.
 */
export async function syncSchema(): Promise<void> {
  const started = Date.now();
  console.log("[schema] applying schema to the database...");
  try {
    // Reviewed additive steps push would otherwise refuse (see the file).
    await run(
      process.execPath,
      [
        "node_modules/prisma/build/index.js",
        "db",
        "execute",
        "--file",
        "prisma/pre-push.sql",
        "--schema",
        "prisma/schema.prisma",
      ],
      { timeout: TIMEOUT_MS, env: process.env },
    );
    const args = [
      "node_modules/prisma/build/index.js",
      "db",
      "push",
      "--skip-generate",
      "--schema",
      "prisma/schema.prisma",
    ];
    if (process.env.ACCEPT_SCHEMA_DATA_LOSS === "1") {
      args.push("--accept-data-loss");
    }
    const { stdout, stderr } = await run(process.execPath, args, {
      timeout: TIMEOUT_MS,
      env: process.env,
    });
    const out = `${stdout}${stderr}`.trim();
    // Push is quiet when there is nothing to do, which is the common case and
    // worth saying out loud so a deploy log shows it ran at all.
    const changed = !/already in sync/i.test(out);
    console.log(
      `[schema] ${changed ? "applied changes" : "already in sync"} in ${Date.now() - started}ms`,
    );
    if (changed && out) console.log(out.split("\n").slice(-6).join("\n"));
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error("[schema] FAILED to apply the schema:", detail);
    // Prisma lists what it objected to on its own output, not in the error
    // message, and the message alone only says "use --accept-data-loss". A
    // deploy refused on 2026-10-10 logged exactly that and nothing else, so
    // nobody could tell which change was the destructive one without
    // reconstructing the diff by hand. Print the list; it names tables and
    // columns, never data.
    const { stdout: failOut, stderr: failErr } = err as { stdout?: string; stderr?: string };
    const listed = `${failOut ?? ""}${failErr ?? ""}`.trim();
    if (listed) console.error(listed.split("\n").slice(-20).join("\n"));
    // Two failures look alike from here and need different responses, so name
    // them rather than making whoever is on call guess.
    if (/data loss|destructive/i.test(detail)) {
      console.error(
        "[schema] The change would drop data. Nothing was applied. Review the diff and apply it by hand.",
      );
    } else if (/ENOENT|Cannot find module/i.test(detail)) {
      console.error(
        "[schema] The Prisma CLI is not present in this image. It must be a runtime dependency, not a dev one.",
      );
    }
    throw err instanceof Error ? err : new Error(detail);
  }
}
