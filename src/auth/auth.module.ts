import { Module } from "@nestjs/common";

import { PrismaModule } from "../prisma/prisma.module";
import { TenantApiKeyService } from "./tenant-api-key.service";
import { TenantApiKeyGuard } from "./tenant-api-key.guard";
import { TenantRlsInterceptor } from "./tenant-rls.interceptor";
import { TenantController } from "./tenant.controller";

@Module({
  imports: [PrismaModule],
  controllers: [TenantController],
  providers: [TenantApiKeyService, TenantApiKeyGuard, TenantRlsInterceptor],
  exports: [TenantApiKeyService, TenantApiKeyGuard, TenantRlsInterceptor],
})
export class AuthModule {}
