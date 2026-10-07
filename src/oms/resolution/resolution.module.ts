import { Module } from "@nestjs/common";

import { PrismaModule } from "../../prisma/prisma.module";
import { AuthModule } from "../../auth/auth.module";
import { AuditModule } from "../audit/audit.module";
import { ExceptionModule } from "../exception/exception.module";
import { InventoryModule } from "../inventory/inventory.module";
import { InvestigationModule } from "../investigation/investigation.module";

import { ResolutionController } from "./resolution.controller";
import { ResolutionService } from "./resolution.service";

@Module({
  imports: [
    PrismaModule,
    AuthModule,
    AuditModule,
    ExceptionModule,
    InventoryModule,
    InvestigationModule,
  ],
  controllers: [ResolutionController],
  providers: [ResolutionService],
  exports: [ResolutionService],
})
export class ResolutionModule {}
