/*
  Warnings:

  - You are about to drop the column `shopifyInventoryItemId` on the `InventoryItem` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[inventoryItemId,locationId]` on the table `InventoryBalance` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `locationId` to the `InventoryBalance` table without a default value. This is not possible if the table is not empty.
  - Added the required column `locationId` to the `InventoryMovement` table without a default value. This is not possible if the table is not empty.
  - Added the required column `locationId` to the `InventoryReservation` table without a default value. This is not possible if the table is not empty.

*/
-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "StorePlatform" ADD VALUE 'AMAZON';
ALTER TYPE "StorePlatform" ADD VALUE 'WOOCOMMERCE';
ALTER TYPE "StorePlatform" ADD VALUE 'EBAY';
ALTER TYPE "StorePlatform" ADD VALUE 'OTHER';

-- DropIndex
DROP INDEX "InventoryBalance_inventoryItemId_key";

-- DropIndex
DROP INDEX "InventoryItem_storeId_shopifyInventoryItemId_idx";

-- AlterTable
ALTER TABLE "InventoryBalance" ADD COLUMN     "locationId" UUID;

-- AlterTable
ALTER TABLE "InventoryItem" DROP COLUMN "shopifyInventoryItemId";

-- AlterTable
ALTER TABLE "InventoryMovement" ADD COLUMN     "locationId" UUID;

-- AlterTable
ALTER TABLE "InventoryReservation" ADD COLUMN     "locationId" UUID;

-- AlterTable
ALTER TABLE "StoreConnection" ADD COLUMN     "externalStoreId" TEXT;

-- CreateTable
CREATE TABLE "InventoryLocation" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "storeId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InventoryLocation_pkey" PRIMARY KEY ("id")
);
-- ============================================================
-- TechMart inventory migration backfill
-- Create one DEFAULT location per existing store.
-- V1 operates with one location, while the schema supports many.
-- ============================================================

INSERT INTO "InventoryLocation" (
    "id",
    "tenantId",
    "storeId",
    "code",
    "name",
    "active",
    "updatedAt"
)
SELECT
    gen_random_uuid(),
    "tenantId",
    "id",
    'DEFAULT',
    'Default Location',
    true,
    CURRENT_TIMESTAMP
FROM "StoreConnection";

-- Attach existing inventory balances to their store's DEFAULT location.
UPDATE "InventoryBalance" b
SET "locationId" = l."id"
FROM "InventoryItem" i
JOIN "InventoryLocation" l
  ON l."tenantId" = i."tenantId"
 AND l."storeId" = i."storeId"
 AND l."code" = 'DEFAULT'
WHERE b."inventoryItemId" = i."id"
  AND b."locationId" IS NULL;

-- Attach any existing reservations to their store's DEFAULT location.
UPDATE "InventoryReservation" r
SET "locationId" = l."id"
FROM "InventoryLocation" l
WHERE r."tenantId" = l."tenantId"
  AND r."storeId" = l."storeId"
  AND l."code" = 'DEFAULT'
  AND r."locationId" IS NULL;

-- Attach any existing movements to their store's DEFAULT location.
UPDATE "InventoryMovement" m
SET "locationId" = l."id"
FROM "InventoryLocation" l
WHERE m."tenantId" = l."tenantId"
  AND m."storeId" = l."storeId"
  AND l."code" = 'DEFAULT'
  AND m."locationId" IS NULL;

-- Now enforce the invariant.
ALTER TABLE "InventoryBalance"
ALTER COLUMN "locationId" SET NOT NULL;

ALTER TABLE "InventoryReservation"
ALTER COLUMN "locationId" SET NOT NULL;

ALTER TABLE "InventoryMovement"
ALTER COLUMN "locationId" SET NOT NULL;


-- CreateTable
CREATE TABLE "InventoryItemExternalReference" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "storeId" UUID NOT NULL,
    "inventoryItemId" UUID NOT NULL,
    "platform" "StorePlatform" NOT NULL,
    "externalId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InventoryItemExternalReference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryLocationExternalReference" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "storeId" UUID NOT NULL,
    "locationId" UUID NOT NULL,
    "platform" "StorePlatform" NOT NULL,
    "externalId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InventoryLocationExternalReference_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "InventoryLocation_tenantId_storeId_active_idx" ON "InventoryLocation"("tenantId", "storeId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryLocation_storeId_code_key" ON "InventoryLocation"("storeId", "code");

-- CreateIndex
CREATE INDEX "InventoryItemExternalReference_tenantId_storeId_platform_idx" ON "InventoryItemExternalReference"("tenantId", "storeId", "platform");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryItemExternalReference_storeId_platform_externalId_key" ON "InventoryItemExternalReference"("storeId", "platform", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryItemExternalReference_storeId_inventoryItemId_plat_key" ON "InventoryItemExternalReference"("storeId", "inventoryItemId", "platform");

-- CreateIndex
CREATE INDEX "InventoryLocationExternalReference_tenantId_storeId_platfor_idx" ON "InventoryLocationExternalReference"("tenantId", "storeId", "platform");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryLocationExternalReference_storeId_platform_externa_key" ON "InventoryLocationExternalReference"("storeId", "platform", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryLocationExternalReference_storeId_locationId_platf_key" ON "InventoryLocationExternalReference"("storeId", "locationId", "platform");

-- CreateIndex
CREATE INDEX "InventoryBalance_locationId_idx" ON "InventoryBalance"("locationId");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryBalance_inventoryItemId_locationId_key" ON "InventoryBalance"("inventoryItemId", "locationId");

-- CreateIndex
CREATE INDEX "InventoryMovement_locationId_createdAt_idx" ON "InventoryMovement"("locationId", "createdAt");

-- CreateIndex
CREATE INDEX "InventoryReservation_locationId_status_idx" ON "InventoryReservation"("locationId", "status");

-- AddForeignKey
ALTER TABLE "InventoryLocation" ADD CONSTRAINT "InventoryLocation_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryLocation" ADD CONSTRAINT "InventoryLocation_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "StoreConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryBalance" ADD CONSTRAINT "InventoryBalance_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "InventoryLocation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryReservation" ADD CONSTRAINT "InventoryReservation_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "InventoryLocation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryMovement" ADD CONSTRAINT "InventoryMovement_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "InventoryLocation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryItemExternalReference" ADD CONSTRAINT "InventoryItemExternalReference_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryItemExternalReference" ADD CONSTRAINT "InventoryItemExternalReference_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "StoreConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryItemExternalReference" ADD CONSTRAINT "InventoryItemExternalReference_inventoryItemId_fkey" FOREIGN KEY ("inventoryItemId") REFERENCES "InventoryItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryLocationExternalReference" ADD CONSTRAINT "InventoryLocationExternalReference_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryLocationExternalReference" ADD CONSTRAINT "InventoryLocationExternalReference_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "StoreConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryLocationExternalReference" ADD CONSTRAINT "InventoryLocationExternalReference_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "InventoryLocation"("id") ON DELETE CASCADE ON UPDATE CASCADE;


