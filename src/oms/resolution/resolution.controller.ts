import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";

import { ExceptionSeverity, ExceptionStatus } from "@prisma/client";

import { AuthTenant } from "../../auth/auth-tenant.decorator";
import { TenantApiKeyGuard } from "../../auth/tenant-api-key.guard";
import { TenantRlsInterceptor } from "../../auth/tenant-rls.interceptor";
import { ExceptionService } from "../exception/exception.service";
import { InvestigationContextService } from "../investigation/investigation-context.service";
import { ResolutionService } from "./resolution.service";

type ClaimExceptionRequest = {
  actorType: "USER" | "SYSTEM" | "INTEGRATION";
  actorId?: string;
};

@Controller("oms/exceptions")
@UseGuards(TenantApiKeyGuard)
@UseInterceptors(TenantRlsInterceptor)
export class ResolutionController {
  constructor(
    private readonly resolutionService: ResolutionService,
    private readonly investigationContextService: InvestigationContextService,
    private readonly exceptionService: ExceptionService,
  ) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  async listExceptions(
    @AuthTenant() tenantId: string,
    @Query("storeId") storeId: string,
    @Query("status") status?: ExceptionStatus,
    @Query("severity") severity?: ExceptionSeverity,
  ) {
    if (!storeId?.trim()) {
      throw new BadRequestException("storeId is required");
    }

    const exceptions = await this.exceptionService.list({
      tenantId,
      storeId: storeId.trim(),
      status,
      severity,
    });

    return { count: exceptions.length, exceptions };
  }

  @Get(":exceptionId/investigation")
  @HttpCode(HttpStatus.OK)
  async getInvestigationContext(
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

    return this.investigationContextService.getContext({
      tenantId,
      storeId: storeId.trim(),
      exceptionId: exceptionId.trim(),
    });
  }

  @Post(":exceptionId/claim")
  @HttpCode(HttpStatus.OK)
  async claimException(
    @Param("exceptionId") exceptionId: string,
    @AuthTenant() tenantId: string,
    @Query("storeId") storeId: string,
    @Body() body: ClaimExceptionRequest,
  ) {
    if (!storeId?.trim()) {
      throw new BadRequestException("storeId is required");
    }

    return this.resolutionService.claim({
      tenantId,
      storeId: storeId.trim(),
      exceptionId,
      actorType: body.actorType,
      actorId: body.actorId,
    });
  }

  @Post(":exceptionId/resolve")
  @HttpCode(HttpStatus.OK)
  async resolveException(
    @Param("exceptionId") exceptionId: string,
    @AuthTenant() tenantId: string,
    @Query("storeId") storeId: string,
  ) {
    if (!storeId?.trim()) {
      throw new BadRequestException("storeId is required");
    }

    return this.resolutionService.resolve({
      tenantId,
      storeId: storeId.trim(),
      exceptionId,
    });
  }
}
