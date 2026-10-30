import { describe, expect, it, vi, beforeEach } from "vitest";

const createMock = vi.fn();
const constructorOptions: Array<Record<string, unknown>> = [];
const requestOptions: Array<Record<string, unknown>> = [];

vi.mock("groq-sdk", () => {
  class MockAPIError extends Error {
    status?: number;

    constructor(status?: number, message = "api error") {
      super(message);
      this.status = status;
    }
  }

  class MockAPIUserAbortError extends MockAPIError {}
  class MockAPIConnectionError extends MockAPIError {}
  class MockAPIConnectionTimeoutError extends MockAPIConnectionError {}

  class MockGroq {
    chat = {
      completions: {
        create: (body: unknown, options: Record<string, unknown>) => {
          requestOptions.push(options);
          return createMock(body);
        },
      },
    };

    static APIError = MockAPIError;
    static APIUserAbortError = MockAPIUserAbortError;
    static APIConnectionError = MockAPIConnectionError;
    static APIConnectionTimeoutError = MockAPIConnectionTimeoutError;

    constructor(options: Record<string, unknown>) {
      constructorOptions.push(options);
    }
  }

  return { default: MockGroq };
});

import Groq from "groq-sdk";

import { GroqLlmClient } from "./groq-llm.client";
import { LlmClientError } from "./llm-error";

function buildClient(config: Record<string, unknown> = {}): GroqLlmClient {
  const values: Record<string, unknown> = {
    GROQ_API_KEY: "test-key",
    GROQ_MODEL: "test-model",
    GROQ_TIMEOUT_MS: 5000,
    ...config,
  };

  return new GroqLlmClient({
    get: (key: string) => values[key],
  } as never);
}

const simpleInput = {
  messages: [{ role: "user" as const, content: "hello" }],
  tools: [],
};

beforeEach(() => {
  createMock.mockReset();
  constructorOptions.length = 0;
  requestOptions.length = 0;
});

describe("GroqLlmClient lifecycle", () => {
  it("returns the completion and forwards token usage on success", async () => {
    createMock.mockResolvedValue({
      choices: [
        {
          message: { role: "assistant", content: "hi", tool_calls: undefined },
        },
      ],
      usage: { total_tokens: 42 },
    });

    const client = buildClient();
    const result = await client.createChatCompletion(simpleInput);

    expect(result.message.content).toBe("hi");
    expect(result.tokensUsed).toBe(42);
  });

  it("runs with maxRetries: 0 and a bounded timeout at client AND request level", async () => {
    createMock.mockResolvedValue({
      choices: [{ message: { role: "assistant", content: "hi" } }],
      usage: null,
    });

    const client = buildClient({ GROQ_TIMEOUT_MS: 5000 });
    await client.createChatCompletion(simpleInput);

    // Client construction: the SDK default is maxRetries 2 — overridden.
    expect(constructorOptions[0]).toMatchObject({
      maxRetries: 0,
      timeout: 5000,
    });

    // Per-request: timeout bounded, no client-layer retry, signal slot.
    expect(requestOptions[0]).toMatchObject({
      timeout: 5000,
      maxRetries: 0,
    });
    expect("signal" in (requestOptions[0] ?? {})).toBe(true);
  });

  it("clamps the configured timeout into safe bounds", async () => {
    createMock.mockResolvedValue({
      choices: [{ message: { role: "assistant", content: "hi" } }],
      usage: null,
    });

    const client = buildClient({ GROQ_TIMEOUT_MS: 5 });
    await client.createChatCompletion(simpleInput);

    expect((requestOptions[0] ?? {}).timeout).toBe(1000);
  });

  it("classifies provider timeouts as retryable timeout failures", async () => {
    createMock.mockRejectedValue(
      new (Groq as any).APIConnectionTimeoutError(undefined, "timed out"),
    );

    const client = buildClient();

    await expect(client.createChatCompletion(simpleInput)).rejects.toMatchObject({
      name: "LlmClientError",
      kind: "timeout",
      retryable: true,
    });
  });

  it("cancels BEFORE dispatch when the run's signal is already aborted", async () => {
    const client = buildClient();
    const controller = new AbortController();
    controller.abort();

    await expect(
      client.createChatCompletion({ ...simpleInput, signal: controller.signal }),
    ).rejects.toMatchObject({ kind: "cancelled", retryable: false });

    // Physical cancellation semantics: nothing was sent.
    expect(createMock).not.toHaveBeenCalled();
  });

  it("physically aborts the HTTP request when the owning run cancels", async () => {
    const controller = new AbortController();

    createMock.mockImplementation(
      () =>
        new Promise((_, reject) => {
          controller.signal.addEventListener("abort", () => {
            // fetch-abort semantics inside the SDK
            reject(new (Groq as any).APIUserAbortError());
          });
        }),
    );

    const client = buildClient();
    const pending = client.createChatCompletion({
      ...simpleInput,
      signal: controller.signal,
    });

    controller.abort();

    await expect(pending).rejects.toMatchObject({
      kind: "cancelled",
      retryable: false,
    });
  });

  it("distinguishes an SDK timeout from run cancellation via the signal", async () => {
    const controller = new AbortController();

    createMock.mockRejectedValue(
      new (Groq as any).APIConnectionTimeoutError(undefined, "timed out"),
    );

    const client = buildClient();

    // Signal still live → provider timeout, not cancellation.
    await expect(
      client.createChatCompletion({ ...simpleInput, signal: controller.signal }),
    ).rejects.toMatchObject({ kind: "timeout" });

    // Signal aborted → the abort wins the classification.
    controller.abort();
    createMock.mockRejectedValue(new Error("socket hang up"));
    await expect(
      client.createChatCompletion({ ...simpleInput, signal: controller.signal }),
    ).rejects.toMatchObject({ kind: "cancelled" });
  });

  it("classifies connection failures as transport errors", async () => {
    createMock.mockRejectedValue(
      new (Groq as any).APIConnectionError(undefined, "ECONNREFUSED"),
    );

    const client = buildClient();

    await expect(client.createChatCompletion(simpleInput)).rejects.toMatchObject({
      kind: "transport",
      retryable: true,
    });
  });

  it("classifies HTTP error statuses with the status recorded", async () => {
    createMock.mockRejectedValue(
      new (Groq as any).APIError(429, "rate limited"),
    );

    const client = buildClient();

    const error = await client
      .createChatCompletion(simpleInput)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(LlmClientError);
    expect(error).toMatchObject({ kind: "http", status: 429, retryable: true });

    createMock.mockRejectedValue(new (Groq as any).APIError(400, "bad request"));
    await expect(client.createChatCompletion(simpleInput)).rejects.toMatchObject({
      kind: "http",
      status: 400,
      retryable: false,
    });
  });

  it("classifies contract-violating responses as malformed_response", async () => {
    createMock.mockResolvedValue({ choices: [], usage: null });

    const client = buildClient();

    await expect(client.createChatCompletion(simpleInput)).rejects.toMatchObject({
      kind: "malformed_response",
      retryable: false,
    });
  });

  it("fails closed without an API key (classified, not thrown raw)", async () => {
    const client = buildClient({ GROQ_API_KEY: "" });

    await expect(client.createChatCompletion(simpleInput)).rejects.toMatchObject({
      kind: "transport",
      retryable: false,
    });
  });
});
