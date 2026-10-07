import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Put,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { AiAutonomyLevel } from "@prisma/client";

import { AuthTenant } from "../auth/auth-tenant.decorator";
import { TenantApiKeyGuard } from "../auth/tenant-api-key.guard";
import { TenantRlsInterceptor } from "../auth/tenant-rls.interceptor";
import { AiAutonomyPolicyService } from "./decision/ai-autonomy-policy.service";

type UpsertPolicyRequest = {
  autonomyLevel: AiAutonomyLevel;
  confidenceThreshold: number;
  maxActionsPerHour: number;
  enabled: boolean;
};

@Controller("ai/autonomy-policies")
@UseGuards(TenantApiKeyGuard)
@UseInterceptors(TenantRlsInterceptor)
export class AiAutonomyPolicyController {
  constructor(private readonly policyService: AiAutonomyPolicyService) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  async list(@AuthTenant() tenantId: string) {
    return this.policyService.listPolicies({ tenantId });
  }

  /**
   * Setting a policy is deliberately explicit and per-action-type:
   * there is no "enable autonomy" master switch. A tenant (or, until
   * Phase 6 ships a UI, an operator acting on their behalf) opts one
   * specific, already-proven action type into auto-execution at a
   * time — matching "earn autonomy gradually," not grant it wholesale.
   */
  @Put(":actionType")
  @HttpCode(HttpStatus.OK)
  async upsert(
    @Param("actionType") actionType: string,
    @AuthTenant() tenantId: string,
    @Body() body: UpsertPolicyRequest,
  ) {
    if (!actionType?.trim()) {
      throw new BadRequestException("actionType is required");
    }

    if (
      typeof body.confidenceThreshold !== "number" ||
      body.confidenceThreshold < 0 ||
      body.confidenceThreshold > 1
    ) {
      throw new BadRequestException(
        "confidenceThreshold must be a number between 0 and 1",
      );
    }

    if (
      typeof body.maxActionsPerHour !== "number" ||
      body.maxActionsPerHour < 0
    ) {
      throw new BadRequestException(
        "maxActionsPerHour must be a non-negative number",
      );
    }

    return this.policyService.upsertPolicy({
      tenantId,
      actionType: actionType.trim(),
      autonomyLevel: body.autonomyLevel ?? AiAutonomyLevel.RECOMMEND_ONLY,
      confidenceThreshold: body.confidenceThreshold,
      maxActionsPerHour: body.maxActionsPerHour,
      enabled: Boolean(body.enabled),
    });
  }
}
