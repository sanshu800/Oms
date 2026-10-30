import { Injectable } from "@nestjs/common";
import type {
  AiModelCallOutcome,
  AiUsageSource,
  Prisma,
} from "@prisma/client";

import { PrismaService } from "../../prisma/prisma.service";
import type { LlmUsage } from "../llm/llm-client.interface";
import { ModelPricingService } from "./model-pricing.service";

export type RecordModelCallInput = {
  tenantId: string;
  storeId: string;
  investigationId: string;
  provider: string;
  model: string;
  usage: LlmUsage;
  outcome: AiModelCallOutcome;
  failureCode?: string | null;
  latencyMs?: number | null;
  occurredAt?: Date;
};

/**
 * Phase 2C: per-invocation usage accounting.
 *
 * One row per ACTUAL model invocation attempt (failed attempts included —
 * they may still consume provider tokens). Stores usage metadata only:
 * provider, model, token counts with honest provenance (REPORTED /
 * ESTIMATED / UNKNOWN), latency, outcome, and versioned cost. Never
 * prompts, credentials, or personal data. Missing/malformed usage is
 * stored as nulls with usageSource UNKNOWN — counts are never invented.
 */
@Injectable()
export class AiUsageService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pricing: ModelPricingService,
  ) {}

  async recordModelCall(input: RecordModelCallInput): Promise<{ id: string }> {
    const usage = input.usage;

    // Honest normalization: partial presence is preserved as partial; the
    // source label distinguishes provider-reported from test-double
    // estimates and from unknown.
    const inputTokens = numberOrNull(usage.inputTokens);
    const outputTokens = numberOrNull(usage.outputTokens);
    const reportedTotal = numberOrNull(usage.totalTokens);
    const totalTokens =
      reportedTotal ??
      (inputTokens !== null && outputTokens !== null
        ? inputTokens + outputTokens
        : null);
    const usageSource: AiUsageSource = usage.source ?? "UNKNOWN";

    const cost = this.pricing.computeCost({
      provider: input.provider,
      model: input.model,
      inputTokens,
      outputTokens,
    });

    const data: Prisma.AiModelCallCreateInput = {
      tenantId: input.tenantId,
      storeId: input.storeId,
      investigationId: input.investigationId,
      provider: input.provider,
      model: input.model,
      inputTokens,
      outputTokens,
      totalTokens,
      usageSource,
      outcome: input.outcome,
      failureCode: input.failureCode ?? null,
      latencyMs: numberOrNull(input.latencyMs),
      costStatus: cost.costStatus,
      pricingVersion:
        cost.costStatus === "UNKNOWN_PRICING"
          ? (cost.pricingVersion ?? null)
          : cost.pricingVersion,
      currency:
        cost.costStatus === "UNKNOWN_PRICING"
          ? (cost.currency ?? null)
          : cost.currency,
      inputCostMicros: cost.inputCostMicros,
      outputCostMicros: cost.outputCostMicros,
      totalCostMicros: cost.totalCostMicros,
      occurredAt: input.occurredAt,
    };

    return this.prisma.aiModelCall.create({ data });
  }
}

function numberOrNull(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
