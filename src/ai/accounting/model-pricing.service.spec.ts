import { describe, expect, it } from "vitest";

import { ModelPricingService } from "./model-pricing.service";

describe("ModelPricingService (Phase 2C)", () => {
  const config = {
    pricingVersion: "2026-10-30.1",
    currency: "USD",
    models: {
      "test:model-a": { inputMicrosPer1M: 500_000, outputMicrosPer1M: 800_000 },
    },
  };

  it("computes integer-micros cost separately for input and output", () => {
    const pricing = new ModelPricingService(config);

    const cost = pricing.computeCost({
      provider: "test",
      model: "model-a",
      inputTokens: 1_000,
      outputTokens: 500,
    });

    expect(cost.costStatus).toBe("CALCULATED");
    if (cost.costStatus !== "CALCULATED") throw new Error("unreachable");
    expect(cost.inputCostMicros).toBe(500n);
    expect(cost.outputCostMicros).toBe(400n);
    expect(cost.totalCostMicros).toBe(900n);
    expect(cost.pricingVersion).toBe("2026-10-30.1");
    expect(cost.currency).toBe("USD");
  });

  it("marks unknown pricing explicitly and never treats it as zero cost", () => {
    const pricing = new ModelPricingService(config);

    const cost = pricing.computeCost({
      provider: "test",
      model: "unlisted-model",
      inputTokens: 1_000,
      outputTokens: 500,
    });

    expect(cost.costStatus).toBe("UNKNOWN_PRICING");
    expect(cost.inputCostMicros).toBeNull();
    expect(cost.outputCostMicros).toBeNull();
    expect(cost.totalCostMicros).toBeNull();
  });

  it("separates unknown pricing from unknown usage", () => {
    const pricing = new ModelPricingService(config);

    const cost = pricing.computeCost({
      provider: "test",
      model: "model-a",
      inputTokens: null,
      outputTokens: null,
    });

    expect(cost.costStatus).toBe("NOT_CALCULABLE");
    expect(cost.totalCostMicros).toBeNull();
    if (cost.costStatus === "NOT_CALCULABLE") {
      expect(cost.pricingVersion).toBe("2026-10-30.1");
    }
  });

  it("keeps historical records reproducible across pricing changes", () => {
    const v1 = new ModelPricingService(config);
    const v2 = new ModelPricingService({
      ...config,
      pricingVersion: "2026-11-01.1",
      models: {
        "test:model-a": {
          inputMicrosPer1M: 1_000_000,
          outputMicrosPer1M: 1_000_000,
        },
      },
    });

    const at1 = v1.computeCost({
      provider: "test",
      model: "model-a",
      inputTokens: 1_000,
      outputTokens: 500,
    });
    const at2 = v2.computeCost({
      provider: "test",
      model: "model-a",
      inputTokens: 1_000,
      outputTokens: 500,
    });

    if (at1.costStatus !== "CALCULATED" || at2.costStatus !== "CALCULATED") {
      throw new Error("unreachable");
    }

    expect(at1.totalCostMicros).toBe(900n);
    expect(at2.totalCostMicros).toBe(1_500n);
    // The version travels WITH the record: recomputation at the old
    // version reproduces the historical figure exactly.
    expect(v1.computeCost({
      provider: "test",
      model: "model-a",
      inputTokens: 1_000,
      outputTokens: 500,
    })).toEqual(at1);
    expect(at1.pricingVersion).not.toBe(at2.pricingVersion);
  });

  it("degrades honestly when the pricing config is absent", () => {
    const pricing = new ModelPricingService({
      pricingVersion: "absent",
      currency: "USD",
      models: {},
    });

    const cost = pricing.computeCost({
      provider: "groq",
      model: "llama-3.1-8b-instant",
      inputTokens: 10,
      outputTokens: 10,
    });

    expect(cost.costStatus).toBe("UNKNOWN_PRICING");
    expect(cost.totalCostMicros).toBeNull();
  });
});
