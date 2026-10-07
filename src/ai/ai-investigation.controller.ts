import {
  BadRequestException,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";

import { AuthTenant } from "../auth/auth-tenant.decorator";
import { TenantApiKeyGuard } from "../auth/tenant-api-key.guard";
import { TenantRlsInterceptor } from "../auth/tenant-rls.interceptor";
import { AiInvestigationService } from "./investigation/ai-investigation.service";

/**
 * Manual trigger, superseded for the common case by the automatic
 * BullMQ-based trigger wiring in Phase 5.3 — kept as an authenticated
 * operator tool (e.g. to force a re-investigation) rather than a
 * dev-only escape hatch now that TenantApiKeyGuard is in place.
 */
@Controller("internal/ai")
@UseGuards(TenantApiKeyGuard)
@UseInterceptors(TenantRlsInterceptor)
export class AiInvestigationController {
  constructor(
    private readonly aiInvestigationService: AiInvestigationService,
  ) {}

  @Post("investigate/:exceptionId")
  @HttpCode(HttpStatus.OK)
  async investigate(
    @Param("exceptionId") exceptionId: string,
    @AuthTenant() tenantId: string,
    @Query("storeId") storeId: string,
  ) {
    if (!exceptionId?.trim()) {
      throw new BadRequestException("exceptionId is required");
    }

    if (!storeId?.trim()) {
      throw new BadRequestException("storeId is required");
    }

    return this.aiInvestigationService.investigate({
      tenantId,
      storeId: storeId.trim(),
      exceptionId: exceptionId.trim(),
    });
  }
}
