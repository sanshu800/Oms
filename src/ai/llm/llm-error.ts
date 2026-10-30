/**
 * Typed classification of LLM provider failures (Phase 2B).
 *
 * Every provider implementation (Groq live client, scripted test doubles,
 * future Jev-backed investigative models) maps its transport into this
 * vocabulary so the investigation layer can reason about failures without
 * parsing vendor error strings:
 *
 * - "timeout"           — the provider request exceeded its bounded
 *                         timeout (physically aborted).
 * - "cancelled"         — the owning investigation run was cancelled
 *                         (timeout/cancellation) and the request was
 *                         aborted via AbortSignal. This IS physical
 *                         cancellation of the HTTP request for providers
 *                         whose SDK supports fetch abort (groq-sdk does).
 * - "transport"         — connection/DNS/socket failure before a valid
 *                         HTTP response was received.
 * - "http"              — the provider answered with an HTTP error status
 *                         (status recorded when known; e.g. 429/5xx).
 * - "malformed_response"— a response arrived but violated the expected
 *                         contract (e.g. no completion choices).
 *
 * `retryable` describes the failure's nature (transient vs permanent);
 * retry POLICY is owned by the job layer (BullMQ), never by the HTTP
 * client — the Groq client runs with maxRetries: 0 (no uncontrolled
 * automatic retry at the HTTP-client layer).
 */
export type LlmFailureKind =
  | "timeout"
  | "cancelled"
  | "transport"
  | "http"
  | "malformed_response";

export class LlmClientError extends Error {
  readonly kind: LlmFailureKind;
  readonly status?: number;
  readonly retryable: boolean;
  /**
   * Phase 2C accounting honesty: "none" when the request provably never
   * left (pre-dispatch cancellation) — safe to refund the reservation;
   * "unknown" when the provider may have consumed tokens (timeout,
   * mid-flight abort, transport loss) — the conservative reservation
   * stands and the account is marked uncertain. Never invent usage.
   */
  readonly usageDisposition?: "none" | "unknown";

  constructor(
    kind: LlmFailureKind,
    message: string,
    options: {
      status?: number;
      retryable?: boolean;
      cause?: unknown;
      usageDisposition?: "none" | "unknown";
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "LlmClientError";
    this.kind = kind;
    this.status = options.status;
    this.usageDisposition = options.usageDisposition;
    this.retryable =
      options.retryable ??
      (kind === "timeout" || kind === "transport" || kind === "http");
  }
}

export function isLlmClientError(error: unknown): error is LlmClientError {
  return error instanceof LlmClientError;
}
