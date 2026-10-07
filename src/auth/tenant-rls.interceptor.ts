import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from "@nestjs/common";
import { Observable, from } from "rxjs";

import { PrismaService } from "../prisma/prisma.service";
import { TENANT_ID_REQUEST_KEY } from "./tenant-api-key.guard";

/**
 * Pairs with TenantApiKeyGuard: once the guard has resolved tenantId
 * onto the request, this makes it the ambient RLS context for every
 * Prisma call made while handling the request — including calls made
 * deep inside services that have no idea an HTTP request is even
 * involved. Apply @UseGuards(TenantApiKeyGuard) and
 * @UseInterceptors(TenantRlsInterceptor) together; the guard without
 * this interceptor would still authenticate correctly, it just
 * wouldn't get the database-level enforcement.
 */
@Injectable()
export class TenantRlsInterceptor implements NestInterceptor {
  constructor(private readonly prisma: PrismaService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest();
    const tenantId = request[TENANT_ID_REQUEST_KEY];

    if (!tenantId) {
      return next.handle();
    }

    return from(
      this.prisma.runAsTenant(tenantId, () => firstValue(next.handle())),
    );
  }
}

function firstValue<T>(source: Observable<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    source.subscribe({
      next: resolve,
      error: reject,
    });
  });
}
