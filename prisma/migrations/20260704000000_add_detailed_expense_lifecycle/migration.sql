-- Give expenses the same lifecycle controls as the rest of finance data.
ALTER TABLE "detailed_expenses" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "detailed_expenses" ADD COLUMN IF NOT EXISTS "deleted" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "detailed_expenses" ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "detailed_expenses_category_date_idx" ON "detailed_expenses"("category", "date");
CREATE INDEX IF NOT EXISTS "detailed_expenses_status_paymentDate_idx" ON "detailed_expenses"("status", "paymentDate");
CREATE INDEX IF NOT EXISTS "detailed_expenses_deleted_idx" ON "detailed_expenses"("deleted");
