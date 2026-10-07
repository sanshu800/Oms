import { createParamDecorator, ExecutionContext } from "@nestjs/common";

import { TENANT_ID_REQUEST_KEY } from "./tenant-api-key.guard";

/**
 * The authenticated tenantId resolved by TenantApiKeyGuard. Only ever
 * use this — never Query("tenantId") or Body().tenantId — on an
 * endpoint that mutates or reads tenant-scoped data.
 */
export const AuthTenant = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string => {
    const request = ctx.switchToHttp().getRequest();

    return request[TENANT_ID_REQUEST_KEY];
  },
);
