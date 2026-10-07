import { Module } from "@nestjs/common";

import { AuthModule } from "../../auth/auth.module";
import { PrismaModule } from "../../prisma/prisma.module";
import { ExceptionModule } from "../exception/exception.module";
import { InventoryModule } from "../inventory/inventory.module";

import { OrderController } from "./order.controller";
import { OrderService } from "./order.service";
import { OrderQueryService } from "./order-query.service";
import { OrderFailureDetectorService } from "./order-failure-detector.service";
import { OrderFailureExceptionService } from "./order-failure-exception.service";

@Module({
  imports: [
    AuthModule,
    PrismaModule,
    InventoryModule,
    ExceptionModule,
  ],
  controllers: [OrderController],
  providers: [
    OrderService,
    OrderQueryService,
    OrderFailureDetectorService,
    OrderFailureExceptionService,
  ],
  exports: [
    OrderService,
    OrderQueryService,
    OrderFailureDetectorService,
    OrderFailureExceptionService,
  ],
})
export class OrderModule {}
