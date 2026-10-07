import { Module } from '@nestjs/common';

import { AuthModule } from '../../auth/auth.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { InventoryController } from './inventory.controller';
import { AllocationService } from './allocation.service';
import { InventoryService } from './inventory.service';
import { InventoryTruthService } from './inventory-truth.service';

@Module({
  imports: [AuthModule, PrismaModule],
  controllers: [InventoryController],
  providers: [
    InventoryService,
    InventoryTruthService,
    AllocationService,
  ],
  exports: [
    InventoryService,
    InventoryTruthService,
    AllocationService,
  ],
})
export class InventoryModule {}
