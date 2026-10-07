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
import { AiDecisionProposalStatus } from "@prisma/client";

import { AuthTenant } from "../auth/auth-tenant.decorator";
import { TenantApiKeyGuard } from "../auth/tenant-api-key.guard";
import { TenantRlsInterceptor } from "../auth/tenant-rls.interceptor";
import { AiDecisionService } from "./decision/ai-decision.service";

type DecideProposalRequest = {
  storeId: string;
  actorId: string;
  note?: string;
};

function requireStoreId(storeId?: string): string {
  if (!storeId?.trim()) {
    throw new BadRequestException("storeId is required");
  }

  return storeId.trim();
}

@Controller("ai")
@UseGuards(TenantApiKeyGuard)
@UseInterceptors(TenantRlsInterceptor)
export class AiDecisionController {
  constructor(private readonly aiDecisionService: AiDecisionService) {}

  @Get("proposals")
  @HttpCode(HttpStatus.OK)
  async listProposals(
    @AuthTenant() tenantId: string,
    @Query("storeId") storeId: string,
    @Query("status") status?: AiDecisionProposalStatus,
  ) {
    return this.aiDecisionService.listProposals({
      tenantId,
      storeId: requireStoreId(storeId),
      status,
    });
  }

  @Get("exceptions/:exceptionId/proposals")
  @HttpCode(HttpStatus.OK)
  async getExceptionProposals(
    @Param("exceptionId") exceptionId: string,
    @AuthTenant() tenantId: string,
    @Query("storeId") storeId: string,
  ) {
    if (!exceptionId?.trim()) {
      throw new BadRequestException("exceptionId is required");
    }

    return this.aiDecisionService.getExceptionProposals({
      tenantId,
      storeId: requireStoreId(storeId),
      exceptionId: exceptionId.trim(),
    });
  }

  @Get("proposals/:proposalId")
  @HttpCode(HttpStatus.OK)
  async getProposal(
    @Param("proposalId") proposalId: string,
    @AuthTenant() tenantId: string,
    @Query("storeId") storeId: string,
  ) {
    if (!proposalId?.trim()) {
      throw new BadRequestException("proposalId is required");
    }

    return this.aiDecisionService.getProposal({
      tenantId,
      storeId: requireStoreId(storeId),
      proposalId: proposalId.trim(),
    });
  }

  @Post("proposals/:proposalId/approve")
  @HttpCode(HttpStatus.OK)
  async approveProposal(
    @Param("proposalId") proposalId: string,
    @AuthTenant() tenantId: string,
    @Body() body: DecideProposalRequest,
  ) {
    if (!body.actorId?.trim()) {
      throw new BadRequestException("actorId is required");
    }

    return this.aiDecisionService.approve({
      tenantId,
      storeId: requireStoreId(body.storeId),
      proposalId,
      actorId: body.actorId.trim(),
      note: body.note,
    });
  }

  @Post("proposals/:proposalId/reject")
  @HttpCode(HttpStatus.OK)
  async rejectProposal(
    @Param("proposalId") proposalId: string,
    @AuthTenant() tenantId: string,
    @Body() body: DecideProposalRequest,
  ) {
    if (!body.actorId?.trim()) {
      throw new BadRequestException("actorId is required");
    }

    return this.aiDecisionService.reject({
      tenantId,
      storeId: requireStoreId(body.storeId),
      proposalId,
      actorId: body.actorId.trim(),
      note: body.note,
    });
  }
}
