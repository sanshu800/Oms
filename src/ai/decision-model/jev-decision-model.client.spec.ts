import { describe, expect, it, vi } from "vitest";

import {
  JevDecisionModelClient,
  JEV_MAX_TIMEOUT_MS,
  JEV_MIN_TIMEOUT_MS,
  buildJevQuestions,
  clampTimeoutMs,
} from "./jev-decision-model.client";
import {
  CLASSIFICATION_OPTIONS,
  DECISION_USE_CASES,
  ROUTING_PLANS,
  TriageEvidence,
} from "./decision-model.types";

const evidence: TriageEvidence = {
  detectionStatus: "INSUFFICIENT_INVENTORY",
  skuKnown: true,
  requestedQty: 26,
  availableQty: 25,
  shortageQty: 1,
  inventoryIsStale: false,
  orderAgeHours: 3,
  lineItemTitle: "Black Tee (M)",
  customerNote: "Please hurry",
  priorExceptionsForSku: 0,
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function okChoiceBody(choice: string, confidence = 0.9): unknown {
  return {
    model: "jev-1.13.0",
    answers: {
      decision: {
        type: "choice",
        choice,
        confidence,
        probabilities: { [choice]: 1 },
      },
    },
    usage: { input_tokens: 120, output_tokens: 12 },
  };
}

describe("buildJevQuestions (code-owned closed sets)", () => {
  it("builds one question per use case from the frozen option sets", () => {
    const classification = buildJevQuestions("EXCEPTION_CLASSIFICATION").decision!;
    expect(classification.type).toBe("choice");
    expect(Object.keys(classification.criteria as object).sort()).toEqual(
      [...CLASSIFICATION_OPTIONS].sort(),
    );

    const urgency = buildJevQuestions("URGENCY_SCORING").decision!;
    expect(urgency.type).toBe("score");
    expect((urgency.criteria as unknown[]).length).toBe(4);

    const routing = buildJevQuestions("INVESTIGATION_PATH_ROUTING").decision!;
    expect(routing.type).toBe("choice");
    expect(Object.keys(routing.criteria as object).sort()).toEqual(
      [...ROUTING_PLANS].sort(),
    );
  });
});

describe("JevDecisionModelClient", () => {
  it("sends the verified wire shape and the REDACTED state, then returns a typed OK", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, okChoiceBody("INSUFFICIENT_INVENTORY")),
    );

    const client = new JevDecisionModelClient({
      apiKey: "test-key",
      model: "jev-1.13.0",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const outcome = await client.decide({
      useCase: "EXCEPTION_CLASSIFICATION",
      evidence: { ...evidence, tenantId: "tenant-secret", sku: "SKU-SECRET" },
    });

    expect(outcome.status).toBe("OK");
    if (outcome.status !== "OK") throw new Error("unreachable");

    expect(outcome.answer.kind).toBe("choice");
    expect(outcome.model).toBe("jev-1.13.0");
    expect(outcome.usage).toEqual({ inputTokens: 120, outputTokens: 12 });
    expect(outcome.lowConfidence).toBe(false);

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer test-key",
    );

    const body = JSON.parse(init.body as string);
    expect(Object.keys(body).sort()).toEqual(["model", "questions", "state"]);
    expect(body.model).toBe("jev-1.13.0");
    expect(body.questions.decision.type).toBe("choice");
    // Redaction: identifiers never leave the process.
    expect(JSON.stringify(body.state)).not.toContain("tenant-secret");
    expect(JSON.stringify(body.state)).not.toContain("SKU-SECRET");
  });

  it("flags low confidence below the pre-declared threshold", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, okChoiceBody("FULFILLABLE", 0.2)));

    const client = new JevDecisionModelClient({
      apiKey: "k",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const outcome = await client.decide({
      useCase: "EXCEPTION_CLASSIFICATION",
      evidence,
    });

    expect(outcome.status).toBe("OK");
    if (outcome.status !== "OK") throw new Error("unreachable");
    expect(outcome.lowConfidence).toBe(true);
  });

  it("parses score answers including between-level scores", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        model: "jev-1.13.0",
        answers: {
          decision: {
            type: "score",
            score: 1.7,
            confidence: 0.8,
            legend: { "0": "l0", "1": "l1", "2": "l2", "3": "l3" },
            probabilities: { "0": 0, "1": 0.3, "2": 0.7, "3": 0 },
          },
        },
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
    );

    const client = new JevDecisionModelClient({
      apiKey: "k",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const outcome = await client.decide({
      useCase: "URGENCY_SCORING",
      evidence,
    });

    expect(outcome.status).toBe("OK");
    if (outcome.status !== "OK") throw new Error("unreachable");
    expect(outcome.answer.kind).toBe("score");
    if (outcome.answer.kind !== "score") throw new Error("unreachable");
    expect(outcome.answer.score).toBe(1.7);
  });

  it("returns UNAVAILABLE without an API key and invents no decision", async () => {
    const client = new JevDecisionModelClient({ apiKey: null });

    const outcome = await client.decide({
      useCase: "EXCEPTION_CLASSIFICATION",
      evidence,
    });

    expect(outcome.status).toBe("UNAVAILABLE");
    expect("answer" in outcome).toBe(false);
  });

  it.each([
    [401, "PROVIDER_ERROR", /401/],
    [429, "PROVIDER_ERROR", /429/],
    [529, "PROVIDER_ERROR", /529/],
    [500, "PROVIDER_ERROR", /HTTP 500/],
    [422, "VALIDATION_FAILED", /422/],
  ])(
    "maps HTTP %i to an explicit typed failure with no fallback",
    async (status, expected, pattern) => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValue(jsonResponse(status, { detail: [] }));

      const client = new JevDecisionModelClient({
        apiKey: "k",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });

      const outcome = await client.decide({
        useCase: "EXCEPTION_CLASSIFICATION",
        evidence,
      });

      expect(outcome.status).toBe(expected);
      expect("answer" in outcome).toBe(false);
      if (outcome.status === "OK") throw new Error("unreachable");
      expect(outcome.error).toMatch(pattern);
    },
  );

  it("treats a malformed body, wrong answer type, or out-of-set choice as VALIDATION_FAILED", async () => {
    const cases: Array<[unknown, RegExp]> = [
      ["not-json{{{", /not valid JSON|schema validation/],
      [{ model: "m", answers: {}, usage: { input_tokens: 1, output_tokens: 1 } }, /missing the "decision" answer/],
      [
        {
          model: "m",
          answers: {
            decision: { type: "noul", noul: 0.5 },
          },
          usage: { input_tokens: 1, output_tokens: 1 },
        },
        /answer type "noul"/,
      ],
      [
        {
          model: "m",
          answers: {
            decision: {
              type: "choice",
              choice: "RELEASE_EVERYTHING",
              confidence: 1,
              probabilities: { RELEASE_EVERYTHING: 1 },
            },
          },
          usage: { input_tokens: 1, output_tokens: 1 },
        },
        /out-of-set choice/,
      ],
    ];

    for (const [body, pattern] of cases) {
      const fetchImpl = vi
        .fn()
        .mockResolvedValue(
          body === "not-json{{{"
            ? new Response("not-json{{{", { status: 200 })
            : jsonResponse(200, body),
        );

      const client = new JevDecisionModelClient({
        apiKey: "k",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });

      const outcome = await client.decide({
        useCase: "EXCEPTION_CLASSIFICATION",
        evidence,
      });

      expect(outcome.status).toBe("VALIDATION_FAILED");
      expect("answer" in outcome).toBe(false);
      if (outcome.status === "OK") throw new Error("unreachable");
      expect(outcome.error).toMatch(pattern);
    }
  });

  it("cancels the request at the bounded timeout and reports TIMEOUT", async () => {
    let observedSignal: AbortSignal | null | undefined = null;

    const fetchImpl = vi.fn().mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          observedSignal = init.signal;
          init.signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
        }),
    );

    const client = new JevDecisionModelClient({
      apiKey: "k",
      timeoutMs: JEV_MIN_TIMEOUT_MS,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const outcome = await client.decide({
      useCase: "EXCEPTION_CLASSIFICATION",
      evidence,
    });

    expect(outcome.status).toBe("TIMEOUT");
    expect("answer" in outcome).toBe(false);
    if (outcome.status === "OK") throw new Error("unreachable");
    expect(outcome.error).toMatch(/cancelled/);
    // Request cancellation really fired:
    expect(observedSignal).not.toBeNull();
    expect((observedSignal as unknown as AbortSignal).aborted).toBe(true);
  });

  it("maps transport failures to PROVIDER_ERROR without inventing answers", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValue(new TypeError("network down"));

    const client = new JevDecisionModelClient({
      apiKey: "k",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const outcome = await client.decide({
      useCase: "EXCEPTION_CLASSIFICATION",
      evidence,
    });

    expect(outcome.status).toBe("PROVIDER_ERROR");
    expect("answer" in outcome).toBe(false);
    if (outcome.status === "OK") throw new Error("unreachable");
    expect(outcome.error).toMatch(/network down/);
  });

  it("clamps request timeouts to the documented bounds", () => {
    expect(clampTimeoutMs(undefined)).toBe(2000);
    expect(clampTimeoutMs(1)).toBe(JEV_MIN_TIMEOUT_MS);
    expect(clampTimeoutMs(999999)).toBe(JEV_MAX_TIMEOUT_MS);
  });

  it("covers every use case with exactly one closed question", () => {
    for (const useCase of DECISION_USE_CASES) {
      expect(Object.keys(buildJevQuestions(useCase))).toEqual(["decision"]);
    }
  });
});
