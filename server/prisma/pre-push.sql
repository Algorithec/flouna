-- Run against the deployed Postgres immediately before `prisma db push`, by
-- both the pre-deploy step (npm run db:sync) and the boot-time sync
-- (src/lib/schemaSync.ts). Every statement must be idempotent and additive.
--
-- Why this file exists: `db push` refuses to add a unique constraint to a table
-- that has rows unless given --accept-data-loss, even when the column is brand
-- new and every value is null. OndcTransaction.dedupeKey (#69) is exactly that,
-- and the refusal stopped every deploy after it, so the API never listened and
-- flouna.com/api answered 502. Creating the column and index here, by name,
-- leaves push nothing to object to. Nothing is dropped and no row changes.
--
-- Add to this file only changes reviewed as additive; anything that could lose
-- data still belongs in front of a person, not in here.

DO $$
BEGIN
  IF to_regclass('public."OndcTransaction"') IS NOT NULL THEN
    ALTER TABLE "OndcTransaction" ADD COLUMN IF NOT EXISTS "dedupeKey" TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS "OndcTransaction_dedupeKey_key"
      ON "OndcTransaction"("dedupeKey");
  END IF;
END $$;
