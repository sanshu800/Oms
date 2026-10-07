import { Module } from "@nestjs/common";

import { PrismaModule } from "../prisma/prisma.module";
import { AuthModule } from "../auth/auth.module";
import { ShopifyAuthController } from "./shopify-auth.controller";
import { ShopifyAuthService } from "./shopify-auth.service";
import { ShopifyInventoryService } from "./shopify-inventory.service";

@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [ShopifyAuthController],
  providers: [
    ShopifyAuthService,
    ShopifyInventoryService,
  ],
  exports: [
    ShopifyAuthService,
    ShopifyInventoryService,
  ],
})
export class ShopifyModule {}