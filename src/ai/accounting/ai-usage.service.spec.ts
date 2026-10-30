import { describe, expect, it, vi } from "vitest";

import { AiUsageService } from "./ai-usage.service";
import { ModelPricingService } from "./model-pricing.service";

function makeFakePrisma() {
  const created: Array<Record<string, unknown>> = [];

  return {
    created,
    prisma: {
      aiModelCall: {
        create: vi.fn(async (args: { data: Record<string, unknown> }) => {
          const row = { id: `call-${created.length + 1}`, ...args.data };
          created.push(row);
          return row;
        }),
      },
    },
  };
}

function first<T>(values: readonly T[]): T {
  const value = values[0];
  if (value === undefined) {
    throw new Error("expected at least one element");
  }
  return value;
}

const baseInput = {
  tenantId: "tenant-1",
  storeId: "store-1",
  investigationId: "inv-1",
  provider: "groq",
  model: "model-a",
};

describe("AiUsageService (Phase 2C)", () => {
  it("preserves provider-reported usage with REPORTED provenance", async () => {
    const { prisma, created } = makeFakePrisma();
    const service = new AiUsageService(
      prisma as never,
      new ModelPricingService({
        pricingVersion: "v-test",
        currency: "USD",
        models: {
          "groq:model-a": {
            inputMicrosPer1M: 1_000_000,
            outputMicrosPer1M: 1_000_000,
          },
        },
      }),
    );

    await service.recordModelCall({
      ...baseInput,
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        source: "REPORTED",
      },
      outcome: "SUCCESS",
      latencyMs: 42,
    });

    expect(first(created)).toMatchObject({
      provider: "groq",
      model: "model-a",
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      usageSource: "REPORTED",
      outcome: "SUCCESS",
      latencyMs: 42,
      costStatus: "CALCULATED",
      pricingVersion: "v-test",
      currency: "USD",
    });
    expect(first(created).totalCostMicros).toBe(150n);
  });

  it("distinguishes estimated usage from reported usage", async () => {
    const { prisma, created } = makeFakePrisma();
    const service = new AiUsageService(
      prisma as never,
      new ModelPricingService({
        pricingVersion: "v-test",
        currency: "USD",
        models: {},
      }),
    );

    await service.recordModelCall({
      ...baseInput,
      usage: {
        inputTokens: 5,
        outputTokens: 5,
        totalTokens: 10,
        source: "ESTIMATED",
      },
      outcome: "SUCCESS",
    });

    expect(first(created).usageSource).toBe("ESTIMATED");
  });

  it("represents missing usage as nulls — never invented counts", async () => {
    const { prisma, created } = makeFakePrisma();
    const service = new AiUsageService(
      prisma as never,
      new ModelPricingService({
        pricingVersion: "v-test",
        currency: "USD",
        models: {
          "groq:model-a": {
            inputMicrosPer1M: 1_000_000,
            outputMicrosPer1M: 1_000_000,
          },
        },
      }),
    );

    await service.recordModelCall({
      ...baseInput,
      usage: {
        inputTokens: null,
        outputTokens: null,
        totalTokens: null,
        source: "UNKNOWN",
      },
      outcome: "TIMEOUT",
      failureCode: "TIMEOUT",
    });

    expect(first(created)).toMatchObject({
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      usageSource: "UNKNOWN",
      outcome: "TIMEOUT",
      failureCode: "TIMEOUT",
    });
    // Known pricing but unknown usage: cost is NOT calculable — null, not 0.
    expect(first(created).costStatus).toBe("NOT_CALCULABLE");
    expect(first(created).totalCostMicros).toBeNull();
  });

  it("marks unknown pricing explicitly — never zero cost", async () => {
    const { prisma, created } = makeFakePrisma();
    const service = new AiUsageService(
      prisma as never,
      new ModelPricingService({
        pricingVersion: "v-test",
        currency: "USD",
        models: {},
      }),
    );

    await service.recordModelCall({
      ...baseInput,
      usage: {
        inputTokens: 10,
        outputTokens: 10,
        totalTokens: 20,
        source: "REPORTED",
      },
      outcome: "SUCCESS",
    });

    expect(first(created).costStatus).toBe("UNKNOWN_PRICING");
    expect(first(created).inputCostMicros).toBeNull();
    expect(first(created).outputCostMicros).toBeNull();
    expect(first(created).totalCostMicros).toBeNull();
  });

  it("records one row per invocation including failed calls, with model+latency+outcome", async () => {
    const { prisma, created } = makeFakePrisma();
    const service = new AiUsageService(
      prisma as never,
      new ModelPricingService({
        pricingVersion: "v-test",
        currency: "USD",
        models: {},
      }),
    );

    await service.recordModelCall({
      ...baseInput,
      usage: { source: "UNKNOWN", inputTokens: null, outputTokens: null, totalTokens: null },
      outcome: "SUCCESS",
      latencyMs: 10,
    });
    await service.recordModelCall({
      ...baseInput,
      usage: { source: "UNKNOWN", inputTokens: null, outputTokens: null, totalTokens: null },
      outcome: "RATE_LIMITED",
      failureCode: "RATE_LIMITED",
      latencyMs: 5,
    });

    expect(created).toHaveLength(2);
    expect(created.map((row) => row.outcome)).toEqual([
      "SUCCESS",
      "RATE_LIMITED",
    ]);
  });
});
