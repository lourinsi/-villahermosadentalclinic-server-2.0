-- AlterTable
ALTER TABLE "appointments" ADD COLUMN     "treatments" JSONB;

-- AlterTable
ALTER TABLE "detailed_expenses" ALTER COLUMN "totalPaid" DROP NOT NULL;

-- AlterTable
ALTER TABLE "expense_payments" ALTER COLUMN "updatedAt" DROP DEFAULT;
