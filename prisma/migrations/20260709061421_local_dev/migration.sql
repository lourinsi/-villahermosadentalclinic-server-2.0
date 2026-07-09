/*
  Warnings:

  - You are about to drop the column `childAppointmentId` on the `appointments` table. All the data in the column will be lost.
  - You are about to drop the column `isRecurring` on the `appointments` table. All the data in the column will be lost.
  - You are about to drop the column `parentAppointmentId` on the `appointments` table. All the data in the column will be lost.
  - You are about to drop the column `recurrence` on the `appointments` table. All the data in the column will be lost.
  - You are about to drop the column `recurringSeriesId` on the `appointments` table. All the data in the column will be lost.
  - You are about to drop the `recurring_occurrences` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `recurring_series` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropIndex
DROP INDEX "appointments_childAppointmentId_idx";

-- DropIndex
DROP INDEX "appointments_parentAppointmentId_idx";

-- DropIndex
DROP INDEX "appointments_recurringSeriesId_idx";

-- AlterTable
ALTER TABLE "appointments" DROP COLUMN "childAppointmentId",
DROP COLUMN "isRecurring",
DROP COLUMN "parentAppointmentId",
DROP COLUMN "recurrence",
DROP COLUMN "recurringSeriesId";

-- AlterTable
ALTER TABLE "detailed_expenses" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- DropTable
DROP TABLE "recurring_occurrences";

-- DropTable
DROP TABLE "recurring_series";
