/*
  Warnings:

  - Made the column `storeId` on table `AuditEvent` required. This step will fail if there are existing NULL values in that column.
  - Changed the type of `actorType` on the `AuditEvent` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.

*/
-- CreateEnum
CREATE TYPE "AuditActorType" AS ENUM ('SYSTEM', 'USER', 'INTEGRATION');

-- AlterTable
ALTER TABLE "AuditEvent" ALTER COLUMN "storeId" SET NOT NULL,
DROP COLUMN "actorType",
ADD COLUMN     "actorType" "AuditActorType" NOT NULL;
