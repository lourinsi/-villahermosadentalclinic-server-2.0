-- Keep the original expense amount as the legacy source of truth for the bill total,
-- then persist explicit totals for new and partial expense payments.
ALTER TABLE "detailed_expenses"
  ADD COLUMN IF NOT EXISTS "price" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "totalPaid" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "balance" DOUBLE PRECISION;

UPDATE "detailed_expenses"
SET
  "price" = COALESCE("price", "amount"),
  "totalPaid" = CASE
    WHEN LOWER(COALESCE("status", '')) IN ('paid', 'settled', 'complete', 'completed') THEN COALESCE("amount", 0)
    ELSE COALESCE("totalPaid", 0)
  END
WHERE "price" IS NULL OR "totalPaid" IS NULL;

UPDATE "detailed_expenses"
SET "balance" = COALESCE("price", "amount", 0) - COALESCE("totalPaid", 0)
WHERE "balance" IS NULL;
