/*
  Warnings:

  - You are about to drop the column `storeId` on the `InventoryItem` table. All the data in the column will be lost.
  - You are about to drop the column `storeId` on the `InventoryLocation` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[tenantId,sku]` on the table `InventoryItem` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[tenantId,code]` on the table `InventoryLocation` will be added. If there are existing duplicate values, this will fail.

*/
-- DropForeignKey
ALTER TABLE "InventoryItem" DROP CONSTRAINT "InventoryItem_storeId_fkey";

-- DropForeignKey
ALTER TABLE "InventoryLocation" DROP CONSTRAINT "InventoryLocation_storeId_fkey";

-- DropIndex
DROP INDEX "InventoryItem_storeId_sku_key";

-- DropIndex
DROP INDEX "InventoryItem_tenantId_storeId_active_idx";

-- DropIndex
DROP INDEX "InventoryLocation_storeId_code_key";

-- DropIndex
DROP INDEX "InventoryLocation_tenantId_storeId_active_idx";

-- DropIndex
DROP INDEX "InventoryReservation_orderItemId_key";

-- AlterTable
ALTER TABLE "InventoryItem" DROP COLUMN "storeId";

-- AlterTable
ALTER TABLE "InventoryLocation" DROP COLUMN "storeId";

-- CreateIndex
CREATE INDEX "InventoryItem_tenantId_active_idx" ON "InventoryItem"("tenantId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryItem_tenantId_sku_key" ON "InventoryItem"("tenantId", "sku");

-- CreateIndex
CREATE INDEX "InventoryLocation_tenantId_active_idx" ON "InventoryLocation"("tenantId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryLocation_tenantId_code_key" ON "InventoryLocation"("tenantId", "code");
