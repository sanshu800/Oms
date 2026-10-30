/**
 * Provider-agnostic LLM chat/tool-use contract.
 *
 * The investigation orchestrator drives the tool-calling loop itself
 * (so every tool call can be persisted as its own AiToolCall row).
 * An LlmClient implementation only needs to know how to make one
 * chat-completion call against its provider. Swapping providers
 * later (Groq -> Anthropic -> anything else) means writing a new
 * implementation of this interface, not touching the orchestrator.
 */

export type LlmRole = "system" | "user" | "assistant" | "tool";

export type LlmMessage = {
  role: LlmRole;
  content: string | null;
  /**
   * Present only on assistant messages that requested tool calls.
   */
  toolCalls?: LlmToolCallRequest[];
  /**
   * Present only on role "tool" messages: which call this answers.
   */
  toolCallId?: string;
  /**
   * Present only on role "tool" messages: the tool's own name,
   * kept for readability in persisted traces.
   */
  name?: string;
};

export type LlmToolCallRequest = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};

export type LlmToolDefinition = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export type LlmChatCompletionInput = {
  messages: LlmMessage[];
  tools: LlmToolDefinition[];
  /**
   * Cancellation signal owned by the investigation run. Providers MUST
   * forward it to the underlying HTTP request (physically aborting it when
   * the transport supports abort) and MUST NOT retry after abort.
   */
  signal?: AbortSignal;
};

/**
 * Token usage for one model invocation. `source` is provenance, not
 * decoration: REPORTED = provider-reported, ESTIMATED = derived by a test
 * double or estimator, UNKNOWN = not available. Fields stay nullable —
 * missing usage is represented as missing, never invented.
 */
export type LlmUsage = {
  inputTokens?: number | null;
  outputTokens?: number | null;
  totalTokens?: number | null;
  source: "REPORTED" | "ESTIMATED" | "UNKNOWN";
};

export type LlmChatCompletionResult = {
  message: LlmMessage;
  tokensUsed: number | null;
  /** Phase 2C: structured usage with provenance (optional for compat). */
  usage?: LlmUsage;
};

export interface LlmClient {
  /** Provider identity for usage accounting (optional for compat). */
  readonly provider?: string;

  createChatCompletion(
    input: LlmChatCompletionInput,
  ): Promise<LlmChatCompletionResult>;
}

export const LLM_CLIENT = Symbol("LLM_CLIENT");
