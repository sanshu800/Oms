import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";

import { TenantApiKeyService } from "./tenant-api-key.service";

export const TENANT_ID_REQUEST_KEY = "tenantId";

/**
 * Applied to every endpoint that acts on tenant-scoped data. Resolves
 * tenantId from the Authorization header and attaches it to the
 * request — it does NOT read tenantId from the client. A controller
 * behind this guard must use @AuthTenant() to get the tenantId, never
 * a query/body param named tenantId (that value, if present, is
 * simply ignored — the authenticated key is the only source of
 * truth).
 */
@Injectable()
export class TenantApiKeyGuard implements CanActivate {
  constructor(private readonly tenantApiKeyService: TenantApiKeyService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const authHeader: string | undefined = request.headers?.authorization;

    if (!authHeader) {
      throw new UnauthorizedException("Missing Authorization header");
    }

    const [scheme, token] = authHeader.split(" ");

    if (scheme !== "Bearer" || !token?.trim()) {
      throw new UnauthorizedException(
        "Authorization header must be 'Bearer <api key>'",
      );
    }

    const tenantId = await this.tenantApiKeyService.resolveTenantId(
      token.trim(),
    );

    if (!tenantId) {
      throw new UnauthorizedException("Invalid or revoked API key");
    }

    request[TENANT_ID_REQUEST_KEY] = tenantId;

    return true;
  }
}
