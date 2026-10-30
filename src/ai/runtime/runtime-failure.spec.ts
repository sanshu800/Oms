import { describe, expect, it } from "vitest";

import Groq from "groq-sdk";

import { LlmClientError } from "../llm/llm-error";
import { GroqLlmClient, classifyProviderError } from "../llm/groq-llm.client";
import {
  classifyThrownError,
  isRuntimeFailure,
  RUNTIME_FAILURE_CODES,
  runtimeFailure,
} from "./runtime-failure";

describe("RuntimeFailure taxonomy (Phase 2C)", () => {
  it("exposes a closed, stable vocabulary of failure codes", () => {
    expect(RUNTIME_FAILURE_CODES).toEqual([
      "TIMEOUT",
      "CANCELLED",
      "RATE_LIMITED",
      "AUTHENTICATION_FAILED",
      "PROVIDER_UNAVAILABLE",
      "PROVIDER_ERROR",
      "INVALID_RESPONSE",
      "OUTPUT_VALIDATION_FAILED",
      "TOOL_EXECUTION_FAILED",
      "BUDGET_EXCEEDED",
      "INVESTIGATION_CONFLICT",
      "INTERNAL_ERROR",
    ]);
  });

  it("classifies provider timeouts as TIMEOUT with unknown usage", () => {
    const failure = classifyThrownError(
      new LlmClientError("timeout", "clamped timeout after 15000ms", {
        usageDisposition: "unknown",
      }),
    );

    expect(failure.code).toBe("TIMEOUT");
    expect(failure.retryable).toBe(true);
    expect(failure.providerDetail?.kind).toBe("timeout");
    expect(failure.providerDetail?.usageDisposition).toBe("unknown");
  });

  it("never reports cancellation as a provider failure", () => {
    // Explicit run-level cancellation wins over any provider classification.
    const failure = classifyThrownError(
      new LlmClientError("http", "socket hang up", { status: 502 }),
      { cancelled: true },
    );

    expect(failure.code).toBe("CANCELLED");
    expect(failure.retryable).toBe(false);
  });

  it("classifies pre-dispatch cancellation with usageDisposition none", async () => {
    const client = new GroqLlmClient({
      get: (key: string) =>
        key === "GROQ_TIMEOUT_MS" ? 15000 : key === "GROQ_MODEL" ? "m" : undefined,
    } as never);

    await expect(
      client.createChatCompletion({
        messages: [],
        tools: [],
        signal: AbortSignal.abort(),
      }),
    ).rejects.toThrow(LlmClientError);

    const error = await client
      .createChatCompletion({ messages: [], tools: [], signal: AbortSignal.abort() })
      .catch((e: unknown) => e);

    const failure = classifyThrownError(error);
    expect(failure.code).toBe("CANCELLED");
    expect(failure.providerDetail?.usageDisposition).toBe("none");
  });

  it("classifies 429 as RATE_LIMITED and 401/403 as AUTHENTICATION_FAILED", () => {
    expect(
      classifyThrownError(
        new LlmClientError("http", "rate limited", {
          status: 429,
          usageDisposition: "none",
        }),
      ).code,
    ).toBe("RATE_LIMITED");

    expect(
      classifyThrownError(
        new LlmClientError("http", "bad key", {
          status: 401,
          usageDisposition: "none",
        }),
      ).code,
    ).toBe("AUTHENTICATION_FAILED");

    expect(
      classifyThrownError(
        new LlmClientError("http", "forbidden", {
          status: 403,
          usageDisposition: "none",
        }),
      ).code,
    ).toBe("AUTHENTICATION_FAILED");
  });

  it("classifies 5xx as PROVIDER_UNAVAILABLE and transport loss likewise", () => {
    expect(
      classifyThrownError(
        new LlmClientError("http", "bad gateway", {
          status: 502,
          usageDisposition: "unknown",
        }),
      ).code,
    ).toBe("PROVIDER_UNAVAILABLE");

    expect(
      classifyThrownError(
        new LlmClientError("transport", "fetch failed", {
          usageDisposition: "unknown",
        }),
      ).code,
    ).toBe("PROVIDER_UNAVAILABLE");
  });

  it("classifies malformed provider output as INVALID_RESPONSE (permanent)", () => {
    const failure = classifyThrownError(
      new LlmClientError("malformed_response", "no completion choice", {
        usageDisposition: "unknown",
      }),
    );

    expect(failure.code).toBe("INVALID_RESPONSE");
    expect(failure.retryable).toBe(false);
  });

  it("classifies budget exhaustion as permanent BUDGET_EXCEEDED", () => {
    const failure = runtimeFailure("BUDGET_EXCEEDED", "tenant daily limit", {
      retryable: false,
    });

    expect(failure.code).toBe("BUDGET_EXCEEDED");
    expect(failure.retryable).toBe(false);
    expect(isRuntimeFailure(failure)).toBe(true);
  });

  it("maps provider error kinds into the provider classification detail", () => {
    const classified = classifyProviderError(
      new Groq.APIError(503, { error: "bad gateway" }, "bad gateway", undefined),
      undefined,
    );

    expect(classified.kind).toBe("http");
    expect(classified.status).toBe(503);

    const failure = classifyThrownError(classified);
    expect(failure.code).toBe("PROVIDER_UNAVAILABLE");
    expect(failure.providerDetail?.httpStatus).toBe(503);
    expect(failure.providerDetail?.kind).toBe("http");
  });

  it("keeps provider classification without leaking arbitrary error payloads", () => {
    const failure = classifyThrownError(
      new LlmClientError("http", "secret=do-not-store", {
        status: 400,
        usageDisposition: "none",
      }),
    );

    // message is passed through by contract (it is the human-readable
    // detail) but the structured detail carries only the classification.
    expect(failure.providerDetail).toEqual({
      kind: "http",
      httpStatus: 400,
      usageDisposition: "none",
    });
    expect(JSON.stringify(failure.providerDetail)).not.toContain("secret");
  });
});
