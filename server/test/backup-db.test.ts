import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prisma } from "../src/lib/prisma.js";
import { backup } from "../scripts/backup-lib.mjs";

// The nightly backup. What matters about a backup is the night it is needed,
// so these test the ways it could fail silently: a dump that failed but left
// a file behind, a copy of a database caught halfway through a write, and a
// pruning step that deletes something it should not.

const dirs: string[] = [];
function tempDir() {
  const d = mkdtempSync(join(tmpdir(), "flouna-backup-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const PG = "postgresql://u:p@db.example:5432/flouna";

describe("a Postgres backup", () => {
  it("fails loudly when the dump fails, and leaves nothing that looks like a backup", async () => {
    const dir = tempDir();
    const dumpPostgres = async (_url: string, file: string) => {
      writeFileSync(file, "partial");
      throw new Error("pg_dump: connection refused");
    };
    await expect(backup({ url: PG, dir, dumpPostgres })).rejects.toThrow(/connection refused/);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("refuses an empty dump", async () => {
    const dir = tempDir();
    const dumpPostgres = async (_url: string, file: string) => writeFileSync(file, "");
    await expect(backup({ url: PG, dir, dumpPostgres })).rejects.toThrow(/empty/);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("keeps a good dump under a dated name", async () => {
    const dir = tempDir();
    const dumpPostgres = async (_url: string, file: string) => writeFileSync(file, "PGDMP data");
    const { file } = await backup({ url: PG, dir, dumpPostgres, now: new Date("2026-10-07T20:30:00Z") });
    expect(file).toMatch(/flouna-2026-10-07T20-30-00-000Z\.dump$/);
    expect(readFileSync(file, "utf8")).toBe("PGDMP data");
  });
});

describe("a SQLite backup", () => {
  it("is a consistent snapshot taken by the database, not a file copy", async () => {
    const dir = tempDir();
    const snapshotSqlite = async (file: string) => {
      await prisma.$executeRawUnsafe(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
    };
    const { file } = await backup({ url: "file:./test.db", dir, snapshotSqlite });
    expect(readFileSync(file).subarray(0, 15).toString()).toBe("SQLite format 3");
  });
});

describe("pruning", () => {
  it("removes only old backups, never other files or the new one", async () => {
    const dir = tempDir();
    const old = Date.now() / 1000 - 30 * 86_400;
    for (const name of ["flouna-old.dump", "flouna-old.db", "notes.txt"]) {
      writeFileSync(join(dir, name), "x");
      utimesSync(join(dir, name), old, old);
    }
    const dumpPostgres = async (_url: string, file: string) => writeFileSync(file, "PGDMP");
    const { file, pruned } = await backup({ url: PG, dir, dumpPostgres, retentionDays: 14 });
    expect(pruned).toBe(2);
    expect(existsSync(join(dir, "notes.txt"))).toBe(true);
    expect(existsSync(file)).toBe(true);
  });
});

it("refuses a database it does not recognise", async () => {
  await expect(backup({ url: "mysql://x", dir: tempDir() })).rejects.toThrow(/Unrecognised/);
});
