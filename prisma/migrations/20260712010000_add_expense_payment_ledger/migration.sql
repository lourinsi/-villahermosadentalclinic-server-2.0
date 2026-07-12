CREATE TABLE "expense_payments" (
  "id" TEXT NOT NULL,
  "expenseId" TEXT NOT NULL,
  "amount" DOUBLE PRECISION NOT NULL,
  "method" TEXT NOT NULL,
  "paymentDate" TEXT NOT NULL,
  "transactionId" TEXT,
  "notes" TEXT,
  "idempotencyKey" TEXT,
  "recordedBy" TEXT NOT NULL,
  "recordedByName" TEXT,
  "recordedByRole" TEXT,
  "expenseSnapshot" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deleted" BOOLEAN NOT NULL DEFAULT false,
  "deletedAt" TIMESTAMP(3),
  "deletedBy" TEXT,
  "deletedByName" TEXT,
  "deletedByRole" TEXT,
  CONSTRAINT "expense_payments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "expense_payments_expenseId_fkey" FOREIGN KEY ("expenseId") REFERENCES "detailed_expenses"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "expense_payments_positive_amount" CHECK ("amount" > 0)
);

CREATE TABLE "expense_payment_logs" (
  "id" TEXT NOT NULL,
  "paymentId" TEXT NOT NULL,
  "expenseId" TEXT NOT NULL,
  "changeType" TEXT NOT NULL,
  "previousState" JSONB NOT NULL,
  "newState" JSONB NOT NULL,
  "changedBy" TEXT NOT NULL,
  "changedByName" TEXT,
  "changedByRole" TEXT,
  "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "amountDelta" DOUBLE PRECISION,
  "notes" TEXT,
  CONSTRAINT "expense_payment_logs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "expense_payment_logs_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "expense_payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "expense_payments_transactionId_key" ON "expense_payments"("transactionId");
CREATE UNIQUE INDEX "expense_payments_idempotencyKey_key" ON "expense_payments"("idempotencyKey");
CREATE INDEX "expense_payments_expenseId_paymentDate_idx" ON "expense_payments"("expenseId", "paymentDate");
CREATE INDEX "expense_payments_expenseId_deleted_idx" ON "expense_payments"("expenseId", "deleted");
CREATE INDEX "expense_payments_paymentDate_idx" ON "expense_payments"("paymentDate");
CREATE INDEX "expense_payment_logs_paymentId_changedAt_idx" ON "expense_payment_logs"("paymentId", "changedAt");
CREATE INDEX "expense_payment_logs_expenseId_changedAt_idx" ON "expense_payment_logs"("expenseId", "changedAt");

-- Old versions stored only one cumulative paid amount. Preserve that amount as a
-- deterministic opening entry; no historical split is invented.
INSERT INTO "expense_payments" (
  "id", "expenseId", "amount", "method", "paymentDate", "transactionId",
  "notes", "idempotencyKey", "recordedBy", "recordedByName", "recordedByRole",
  "expenseSnapshot", "createdAt", "updatedAt"
)
SELECT
  'legacy_expense_payment_' || e."id", e."id", e."totalPaid",
  COALESCE(NULLIF(e."paymentMethod", ''), 'Legacy payment'),
  COALESCE(NULLIF(e."paymentDate", ''), e."date"), NULL,
  'Carried forward from the legacy cumulative expense balance.',
  'legacy-expense-' || e."id", 'system', 'Legacy migration', 'system',
  jsonb_build_object('expenseId', e."id", 'price', COALESCE(e."price", e."amount"), 'description', e."description"),
  COALESCE(e."createdAt", CURRENT_TIMESTAMP), COALESCE(e."updatedAt", CURRENT_TIMESTAMP)
FROM "detailed_expenses" e
WHERE COALESCE(e."totalPaid", 0) > 0
ON CONFLICT ("id") DO NOTHING;

UPDATE "detailed_expenses" e SET
  "amount" = p.total_paid,
  "totalPaid" = p.total_paid,
  "balance" = COALESCE(e."price", e."amount", 0) - p.total_paid,
  "status" = CASE
    WHEN LOWER(COALESCE(e."status", '')) IN ('cancelled', 'canceled') THEN 'cancelled'
    WHEN p.total_paid > COALESCE(e."price", e."amount", 0) + 0.01 THEN 'overpaid'
    WHEN p.total_paid >= COALESCE(e."price", e."amount", 0) - 0.01 THEN 'paid'
    WHEN p.total_paid > 0 THEN 'partial' ELSE 'pending' END
FROM (SELECT "expenseId", SUM("amount") total_paid FROM "expense_payments" WHERE NOT "deleted" GROUP BY "expenseId") p
WHERE e."id" = p."expenseId";
