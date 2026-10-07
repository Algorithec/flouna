#!/usr/bin/env node
// Nightly database backup for Flouna. Detects the engine from DATABASE_URL:
//   - SQLite  (file:...)        → a consistent snapshot via VACUUM INTO
//   - Postgres (postgresql://)  → pg_dump in its compressed custom format
//
// Usage (cron, e.g. 2am daily):
//   0 2 * * *  cd /srv/flouna/server && node scripts/backup-db.mjs >> backup.log 2>&1
//
// Restore a Postgres backup with:
//   pg_restore --clean --no-owner --dbname="$DATABASE_URL" backups/flouna-<stamp>.dump
//
// Backups are written to ./backups (override with BACKUP_DIR). Backups older
// than RETENTION_DAYS (default 14) are pruned. Exits non-zero on any failure,
// so the scheduler that runs it can alert. The logic lives in backup-lib.mjs,
// where it is tested.

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { backup } from "./backup-lib.mjs";

const serverDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const url = process.env.DATABASE_URL;

async function snapshotSqlite(file) {
  const { PrismaClient } = await import("@prisma/client");
  const prisma = new PrismaClient();
  try {
    await prisma.$executeRawUnsafe(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  } finally {
    await prisma.$disconnect();
  }
}

try {
  const { file, pruned } = await backup({
    url,
    dir: process.env.BACKUP_DIR || join(serverDir, "backups"),
    retentionDays: Number(process.env.RETENTION_DAYS || 14),
    snapshotSqlite,
  });
  console.log(`Backup written: ${file}`);
  if (pruned) console.log(`Pruned ${pruned} backup(s) past retention.`);
} catch (err) {
  console.error(`Backup failed: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}
