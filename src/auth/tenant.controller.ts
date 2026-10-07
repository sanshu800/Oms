import { Controller, Get, UseGuards, UseInterceptors } from "@nestjs/common";

import { AuthTenant } from "./auth-tenant.decorator";
import { TenantApiKeyGuard } from "./tenant-api-key.guard";
import { TenantRlsInterceptor } from "./tenant-rls.interceptor";
import { PrismaService } from "../prisma/prisma.service";

/**
 * The one endpoint a freshly-pasted API key needs to resolve: who is
 * this, and what stores do they have. Everything else in the UI can
 * be built on top of the storeId(s) this returns.
 */
@Controller()
@UseGuards(TenantApiKeyGuard)
@UseInterceptors(TenantRlsInterceptor)
export class TenantController {
  constructor(private readonly prisma: PrismaService) {}

  @Get("me")
  async me(@AuthTenant() tenantId: string) {
    const [tenant, stores] = await Promise.all([
      this.prisma.tenant.findUnique({
        where: { id: tenantId },
        select: { id: true, name: true, createdAt: true },
      }),
      this.prisma.storeConnection.findMany({
        where: { tenantId },
        select: {
          id: true,
          platform: true,
          shopDomain: true,
          status: true,
          scopes: true,
          installedAt: true,
        },
        orderBy: { installedAt: "desc" },
      }),
    ]);

    return { tenant, stores };
  }
}
