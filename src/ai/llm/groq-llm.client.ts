import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import Groq from "groq-sdk";

import {
  LlmChatCompletionInput,
  LlmChatCompletionResult,
  LlmClient,
  LlmMessage,
} from "./llm-client.interface";
import { LlmClientError } from "./llm-error";

/** Provider timeout bounds (ms), clamped like the Jev client's convention. */
const MIN_PROVIDER_TIMEOUT_MS = 1_000;
const MAX_PROVIDER_TIMEOUT_MS = 120_000;
const DEFAULT_PROVIDER_TIMEOUT_MS = 30_000;

/**
 * Live LLM provider client (Groq).
 *
 * Lifecycle contract (Phase 2B):
 * - Every request is bounded by a configurable timeout
 *   (`GROQ_TIMEOUT_MS`, clamped 1s–120s) AND by the caller's AbortSignal.
 * - The AbortSignal is forwarded to the HTTP request — aborting PHYSICALLY
 *   cancels the fetch (groq-sdk supports request abort); it does not merely
 *   discard the response.
 * - No uncontrolled automatic retry: the SDK client is constructed with
 *   maxRetries: 0 (its default is 2) and every request repeats that.
 *   Retry policy belongs to the job layer (BullMQ), not the HTTP client.
 * - Failures are classified into the shared LlmClientError vocabulary
 *   (timeout | cancelled | transport | http | malformed_response).
 */
@Injectable()
export class GroqLlmClient implements LlmClient {
  readonly provider = "groq";

  private client: Groq | null = null;

  constructor(private readonly config: ConfigService) {}

  private get timeoutMs(): number {
    const configured = this.config.get<number>("GROQ_TIMEOUT_MS");

    if (typeof configured !== "number" || !Number.isFinite(configured)) {
      return DEFAULT_PROVIDER_TIMEOUT_MS;
    }

    return Math.min(
      Math.max(Math.floor(configured), MIN_PROVIDER_TIMEOUT_MS),
      MAX_PROVIDER_TIMEOUT_MS,
    );
  }

  private getClient(): Groq {
    if (this.client) {
      return this.client;
    }

    const apiKey = this.config.get<string>("GROQ_API_KEY");

    if (!apiKey) {
      throw new LlmClientError(
        "transport",
        "GROQ_API_KEY is not configured",
        { retryable: false },
      );
    }

    // maxRetries: 0 — the HTTP client must never retry on its own.
    this.client = new Groq({
      apiKey,
      timeout: this.timeoutMs,
      maxRetries: 0,
    });

    return this.client;
  }

  async createChatCompletion(
    input: LlmChatCompletionInput,
  ): Promise<LlmChatCompletionResult> {
    const model =
      this.config.get<string>("GROQ_MODEL") ?? "openai/gpt-oss-120b";

    if (input.signal?.aborted) {
      throw new LlmClientError(
        "cancelled",
        "Provider call cancelled before dispatch (investigation run aborted)",
        { usageDisposition: "none" },
      );
    }

    let completion: Groq.Chat.ChatCompletion;

    try {
      completion = await this.getClient().chat.completions.create(
        {
          model,
          messages: input.messages.map(toGroqMessage),
          tools:
            input.tools.length > 0
              ? input.tools.map((tool) => ({
                  type: "function" as const,
                  function: {
                    name: tool.name,
                    description: tool.description,
                    parameters: tool.parameters,
                  },
                }))
              : undefined,
          tool_choice: input.tools.length > 0 ? "auto" : undefined,
        },
        {
          // Per-request lifecycle: bounded timeout, caller-owned abort,
          // and no client-side retries.
          signal: input.signal ?? undefined,
          timeout: this.timeoutMs,
          maxRetries: 0,
        },
      );
    } catch (error) {
      throw classifyProviderError(error, input.signal);
    }

    const choice = completion.choices[0];

    if (!choice) {
      throw new LlmClientError(
        "malformed_response",
        "Groq returned no completion choices",
        { retryable: false },
      );
    }

    return {
      message: fromGroqMessage(choice.message),
      tokensUsed: completion.usage?.total_tokens ?? null,
      // Phase 2C: provider-reported usage with honest provenance. Missing
      // usage stays null/UNKNOWN — never estimated from the prompt.
      usage: completion.usage
        ? {
            inputTokens: completion.usage.prompt_tokens ?? null,
            outputTokens: completion.usage.completion_tokens ?? null,
            totalTokens: completion.usage.total_tokens ?? null,
            source: "REPORTED",
          }
        : {
            inputTokens: null,
            outputTokens: null,
            totalTokens: null,
            source: "UNKNOWN",
          },
    };
  }
}

/**
 * Map groq-sdk (fetch) failures onto the shared failure vocabulary. The
 * caller's AbortSignal distinguishes "cancelled by the owning run" from the
 * provider's own timeout, even though both surface as aborts deep in fetch.
 */
export function classifyProviderError(
  error: unknown,
  signal?: AbortSignal,
): LlmClientError {
  if (error instanceof LlmClientError) {
    return error;
  }

  const message = error instanceof Error ? error.message : String(error);

  if (signal?.aborted) {
    return new LlmClientError(
      "cancelled",
      `Provider call cancelled by the owning investigation run: ${message}`,
      { cause: error, retryable: false, usageDisposition: "unknown" },
    );
  }

  if (error instanceof Groq.APIUserAbortError) {
    return new LlmClientError("cancelled", message, {
      cause: error,
      retryable: false,
      usageDisposition: "unknown",
    });
  }

  if (error instanceof Groq.APIConnectionTimeoutError) {
    return new LlmClientError("timeout", message, {
      cause: error,
      usageDisposition: "unknown",
    });
  }

  if (error instanceof Groq.APIConnectionError) {
    return new LlmClientError("transport", message, {
      cause: error,
      usageDisposition: "unknown",
    });
  }

  if (error instanceof Groq.APIError) {
    const status =
      typeof error.status === "number" ? error.status : undefined;

    return new LlmClientError("http", message, {
      cause: error,
      status,
      retryable: status === 429 || (status !== undefined && status >= 500),
      // Rejections (429/4xx) did not generate; 5xx may have.
      usageDisposition:
        status !== undefined && status >= 500 ? "unknown" : "none",
    });
  }

  return new LlmClientError("transport", message, {
    cause: error,
    retryable: false,
    usageDisposition: "unknown",
  });
}

function toGroqMessage(message: LlmMessage): Groq.Chat.ChatCompletionMessageParam {
  if (message.role === "tool") {
    return {
      role: "tool",
      tool_call_id: message.toolCallId ?? "",
      content: message.content ?? "",
    };
  }

  if (message.role === "assistant" && message.toolCalls?.length) {
    return {
      role: "assistant",
      content: message.content,
      tool_calls: message.toolCalls.map((call) => ({
        id: call.id,
        type: "function",
        function: {
          name: call.name,
          arguments: JSON.stringify(call.arguments),
        },
      })),
    };
  }

  return {
    role: message.role,
    content: message.content ?? "",
  } as Groq.Chat.ChatCompletionMessageParam;
}

function fromGroqMessage(
  message: Groq.Chat.ChatCompletionMessage,
): LlmMessage {
  const toolCalls = message.tool_calls?.map((call) => ({
    id: call.id,
    name: call.function.name,
    arguments: safeParseObject(call.function.arguments),
  }));

  return {
    role: "assistant",
    content: message.content,
    toolCalls,
  };
}

function safeParseObject(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);

    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through
  }

  return {};
}
