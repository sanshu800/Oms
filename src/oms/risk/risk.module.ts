import { Module } from "@nestjs/common";

import { PrismaModule } from "../../prisma/prisma.module";
import { ExceptionModule } from "../exception/exception.module";
import { RiskDetectorService } from "./risk-detector.service";

@Module({
  imports: [PrismaModule, ExceptionModule],
  providers: [RiskDetectorService],
  exports: [RiskDetectorService],
})
export class RiskModule {}
