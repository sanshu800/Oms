import { Inject, Injectable, Optional } from "@nestjs/common";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** DI token for embedding a test/deployment-specific pricing snapshot. */
export const MODEL_PRICING_CONFIG = "MODEL_PRICING_CONFIG";

/**
 * Phase 2C: versioned model pricing.
 *
 * Pricing is CONFIGURATION DATA loaded from config/model-pricing.json —
 * never hardcoded in business logic. Every computed cost carries the
 * pricing version and currency so historical records stay reproducible
 * when prices change. Unknown pricing is represented explicitly
 * (costStatus UNKNOWN_PRICING) and is NEVER treated as zero cost.
 */
export type ModelPrice = {
  inputMicrosPer1M: number;
  outputMicrosPer1M: number;
};

export type PricingConfig = {
  pricingVersion: string;
  currency: string;
  models: Record<string, ModelPrice>;
};

export type ComputedCost =
  | {
      costStatus: "CALCULATED";
      pricingVersion: string;
      currency: string;
      inputCostMicros: bigint;
      outputCostMicros: bigint;
      totalCostMicros: bigint;
    }
  | {
      costStatus: "UNKNOWN_PRICING";
      pricingVersion?: string;
      currency?: string;
      inputCostMicros: null;
      outputCostMicros: null;
      totalCostMicros: null;
    }
  | {
      costStatus: "NOT_CALCULABLE";
      pricingVersion: string;
      currency: string;
      inputCostMicros: null;
      outputCostMicros: null;
      totalCostMicros: null;
    };

@Injectable()
export class ModelPricingService {
  private readonly config: PricingConfig;

  constructor(
    @Optional() @Inject(MODEL_PRICING_CONFIG) config?: PricingConfig,
  ) {
    this.config = config ?? loadPricingConfig();
  }

  get pricingVersion(): string {
    return this.config.pricingVersion;
  }

  get currency(): string {
    return this.config.currency;
  }

  priceFor(provider: string, model: string): ModelPrice | null {
    return this.config.models[`${provider.toLowerCase()}:${model.toLowerCase()}`] ?? null;
  }

  /**
   * Cost for one model invocation.
   * - pricing unknown (or token counts missing) => cost fields NULL, with
   *   the distinct status UNKNOWN_PRICING / NOT_CALCULABLE. Never zeros.
   * - only integer micros are stored (no float money).
   */
  computeCost(input: {
    provider: string;
    model: string;
    inputTokens: number | null | undefined;
    outputTokens: number | null | undefined;
  }): ComputedCost {
    const price = this.priceFor(input.provider, input.model);

    if (!price) {
      return {
        costStatus: "UNKNOWN_PRICING",
        inputCostMicros: null,
        outputCostMicros: null,
        totalCostMicros: null,
      };
    }

    if (
      typeof input.inputTokens !== "number" ||
      typeof input.outputTokens !== "number"
    ) {
      return {
        costStatus: "NOT_CALCULABLE",
        pricingVersion: this.config.pricingVersion,
        currency: this.config.currency,
        inputCostMicros: null,
        outputCostMicros: null,
        totalCostMicros: null,
      };
    }

    const inputCostMicros = microsFor(
      input.inputTokens,
      price.inputMicrosPer1M,
    );
    const outputCostMicros = microsFor(
      input.outputTokens,
      price.outputMicrosPer1M,
    );

    return {
      costStatus: "CALCULATED",
      pricingVersion: this.config.pricingVersion,
      currency: this.config.currency,
      inputCostMicros,
      outputCostMicros,
      totalCostMicros: inputCostMicros + outputCostMicros,
    };
  }
}

function microsFor(tokens: number, microsPer1M: number): bigint {
  // Integer arithmetic: tokens * microsPer1M / 1_000_000, rounded.
  return (
    (BigInt(Math.round(tokens)) * BigInt(Math.round(microsPer1M)) +
      500_000n) /
    1_000_000n
  );
}

function loadPricingConfig(): PricingConfig {
  const candidates = [
    join(process.cwd(), "config", "model-pricing.json"),
    join(__dirname, "..", "..", "..", "config", "model-pricing.json"),
    join(__dirname, "..", "..", "..", "..", "config", "model-pricing.json"),
  ];

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(readFileSync(candidate, "utf8")) as PricingConfig;

      if (
        typeof parsed?.pricingVersion === "string" &&
        typeof parsed?.currency === "string" &&
        parsed.models
      ) {
        return parsed;
      }
    } catch {
      // try next candidate
    }
  }

  // Honest degradation: no config -> empty pricing (everything UNKNOWN_PRICING).
  return { pricingVersion: "absent", currency: "USD", models: {} };
}
