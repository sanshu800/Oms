import { Module } from "@nestjs/common";

import { PrismaModule } from "../../prisma/prisma.module";
import { InventoryModule } from "../inventory/inventory.module";
import { FulfillmentService } from "./fulfillment.service";

@Module({
  imports: [PrismaModule, InventoryModule],
  providers: [FulfillmentService],
  exports: [FulfillmentService],
})
export class FulfillmentModule {}
