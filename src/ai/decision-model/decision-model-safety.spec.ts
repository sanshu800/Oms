/**
 * Safety invariants for the DecisionModel capability (V1, advisory-only).
 * These tests exist to catch accidental coupling to authorization or
 * mutation paths — Jev must never be able to authorize or execute.
 */

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { DecisionModel } from "./decision-model.interface";

const decisionModelDir = path.join(__dirname);
const srcDir = path.join(__dirname, "..", "..");

function sourceFilesIn(dir: string): string[] {
  return readdirSync(dir)
    .filter((file) => file.endsWith(".ts"))
    .map((file) => path.join(dir, file));
}

describe("DecisionModel safety invariants", () => {
  it("no decision-model source file imports authorization, actuation, or autonomy code", () => {
    const forbidden = [
      "decision/ai-decision",
      "decision/ai-autonomy",
      "actuation/",
      "resolution/",
    ];

    for (const file of sourceFilesIn(decisionModelDir)) {
      // This spec names those paths on purpose; skip self-scan.
      if (file.endsWith(".spec.ts")) {
        continue;
      }

      const content = readFileSync(file, "utf8");

      for (const pattern of forbidden) {
        expect(
          content.includes(pattern),
          `${path.basename(file)} must not reference ${pattern}`,
        ).toBe(false);
      }
    }
  });

  it("authorization, actuation, and autonomy code do not import decision-model", () => {
    const consumerDirs = [
      path.join(srcDir, "ai", "decision"),
      path.join(srcDir, "ai", "actuation"),
      path.join(srcDir, "ai", "investigation"),
    ];

    for (const dir of consumerDirs) {
      for (const file of sourceFilesIn(dir)) {
        const content = readFileSync(file, "utf8");
        expect(
          content.includes("decision-model"),
          `${path.basename(file)} must not reference decision-model`,
        ).toBe(false);
      }
    }
  });

  it("app.module.ts and ai.module.ts do not wire the DecisionModel module", () => {
    const moduleFiles = [
      path.join(srcDir, "app.module.ts"),
      path.join(srcDir, "ai", "ai.module.ts"),
    ];

    for (const moduleFile of moduleFiles) {
      const content = readFileSync(moduleFile, "utf8");
      expect(content.includes("DecisionModel")).toBe(false);
    }
  });

  it("the port surface exposes only decide() — no authorization verb exists", () => {
    const portSource = readFileSync(
      path.join(decisionModelDir, "decision-model.interface.ts"),
      "utf8",
    );

    for (const verb of ["authorize", "approve", "execute", "mutate", "apply"]) {
      expect(portSource.toLowerCase()).not.toContain(` ${verb}(`);
    }

    const model: DecisionModel = {
      decide: async () => ({
        status: "UNAVAILABLE",
        useCase: "EXCEPTION_CLASSIFICATION",
        error: "test stub",
        latencyMs: 0,
      }),
    };

    expect(Object.keys(model)).toEqual(["decide"]);
  });
});
