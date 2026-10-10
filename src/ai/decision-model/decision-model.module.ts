/**
 * Standalone module composing the DECISION_MODEL port.
 *
 * NOT registered in AppModule in V1 (advisory-only capability; no
 * production consumer). The comparison runner and tests compose it
 * explicitly. Binding rules:
 *   - `scripted` engine → ScriptedDecisionModel (default; no key, no network)
 *   - `jev` engine      → JevDecisionModelClient (requires JEV_API_KEY;
 *                         constructed but never called by any test or dev
 *                         path in this task)
 */

import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import { DECISION_MODEL, DecisionModel } from "./decision-model.interface";
import { JevDecisionModelClient } from "./jev-decision-model.client";
import { ScriptedDecisionModel } from "./scripted-decision-model";

export type DecisionEngine = "scripted" | "jev";

export function createDecisionModel(
  engine: DecisionEngine,
  config?: {
    apiKey?: string | null;
    baseUrl?: string;
    model?: string;
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
  },
): DecisionModel {
  switch (engine) {
    case "scripted":
      return new ScriptedDecisionModel();
    case "jev":
      return new JevDecisionModelClient({
        apiKey: config?.apiKey ?? null,
        baseUrl: config?.baseUrl,
        model: config?.model,
        timeoutMs: config?.timeoutMs,
        fetchImpl: config?.fetchImpl,
      });
  }
}

@Module({
  providers: [
    {
      provide: DECISION_MODEL,
      useFactory: (config: ConfigService): DecisionModel => {
        const engine = config.get<string>("DECISION_MODEL_ENGINE") ?? "scripted";

        return createDecisionModel(
          engine === "jev" ? "jev" : "scripted",
          {
            apiKey: config.get<string>("JEV_API_KEY"),
            baseUrl: config.get<string>("JEV_API_URL"),
            model: config.get<string>("JEV_MODEL"),
            timeoutMs: config.get<number>("JEV_TIMEOUT_MS"),
          },
        );
      },
      inject: [ConfigService],
    },
  ],
  exports: [DECISION_MODEL],
})
export class DecisionModelModule {}
