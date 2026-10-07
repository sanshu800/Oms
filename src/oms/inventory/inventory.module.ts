import { Module } from '@nestjs/common';

import { PrismaModule } from '../../prisma/prisma.module';
import { AllocationService } from './allocation.service';
import { InventoryService } from './inventory.service';
import { InventoryTruthService } from './inventory-truth.service';

@Module({
  imports: [PrismaModule],
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
