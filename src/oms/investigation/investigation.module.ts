import { Module } from "@nestjs/common";

import { PrismaModule } from "../../prisma/prisma.module";
import { ExceptionModule } from "../exception/exception.module";
import { InventoryModule } from "../inventory/inventory.module";

import { InvestigationContextService } from "./investigation-context.service";
import { InvestigationDecisionService } from "./investigation-decision.service";

@Module({
  imports: [
    PrismaModule,
    ExceptionModule,
    InventoryModule,
  ],
  providers: [InvestigationContextService, InvestigationDecisionService],
  exports: [InvestigationContextService, InvestigationDecisionService],
})
export class InvestigationModule {}

