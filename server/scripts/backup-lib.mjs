// The backup itself, kept apart from the command line so it can be tested.
//
// Three ways the first version could fail without anyone noticing, each
// handled here:
//   - "pg_dump | gzip" reports gzip's exit status, so a dump that failed on a
//     wrong password still printed "backup written" over an empty file. The
//     dump now writes its own compressed file and a failure throws.
//   - The SQLite branch copied the live file, which can catch the database
//     halfway through a write. VACUUM INTO asks SQLite for a consistent copy.
//   - Pruning deleted every old file in the folder. It now touches only files
//     this script wrote.
//
// Every backup is written under a temporary name and renamed once it is
// complete and non-empty, so a file with a backup's name is a whole backup.

import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

const OURS = /^flouna-.+\.(dump|db|sql\.gz)$/;

/** pg_dump in its own compressed format; restore with pg_restore. */
export function pgDump(url, file) {
  execFileSync("pg_dump", ["--format=custom", "--no-owner", `--file=${file}`, url], {
    stdio: ["ignore", "inherit", "inherit"],
  });
}

export async function backup({
  url,
  dir,
  now = new Date(),
  retentionDays = 14,
  dumpPostgres = async (u, f) => pgDump(u, f),
  snapshotSqlite,
}) {
  if (!url) throw new Error("DATABASE_URL not set, nothing to back up");
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  let file;
  let write;
  if (url.startsWith("postgres")) {
    file = join(dir, `flouna-${stamp}.dump`);
    write = (tmp) => dumpPostgres(url, tmp);
  } else if (url.startsWith("file:")) {
    if (!snapshotSqlite) throw new Error("no SQLite snapshot function given");
    file = join(dir, `flouna-${stamp}.db`);
    write = (tmp) => snapshotSqlite(tmp);
  } else {
    throw new Error(`Unrecognised DATABASE_URL scheme: ${url.split(":")[0]}`);
  }

  mkdirSync(dir, { recursive: true });
  const tmp = `${file}.partial`;
  try {
    await write(tmp);
    if (statSync(tmp).size === 0) throw new Error("the backup came out empty");
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }

  const cutoff = now.getTime() - retentionDays * 86_400_000;
  let pruned = 0;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (p === file || !OURS.test(name)) continue;
    if (statSync(p).mtimeMs < cutoff) {
      rmSync(p, { force: true });
      pruned++;
    }
  }
  return { file, pruned };
}
