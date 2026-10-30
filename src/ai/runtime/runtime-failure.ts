/**
 * Phase 2C: stable, machine-readable runtime failure taxonomy.
 *
 * Every terminal investigation outcome and every model-call outcome maps to
 * exactly one code from this closed vocabulary. The code is the contract
 * consumers (evaluation, operators, dashboards) branch on — never error
 * message text. `error` strings remain human-readable and unchanged for
 * compatibility; `RuntimeFailure` is additive structure alongside them.
 *
 * Retryability is a property of the FAILURE, not of the policy that reacts
 * to it: the queue worker retries only unrecorded infrastructure failures
 * (its own contract); business outcomes — including BUDGET_EXCEEDED — are
 * persisted and permanent.
 */
export const RUNTIME_FAILURE_CODES = [
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
] as const;

export type RuntimeFailureCode = (typeof RUNTIME_FAILURE_CODES)[number];

export type RuntimeFailure = {
  code: RuntimeFailureCode;
  /** Human-readable detail. Never contains credentials or prompt content. */
  message: string;
  /** Whether an identical retry could plausibly succeed. */
  retryable: boolean;
  /**
   * Preserved provider-level classification (the LlmClientError kind and
   * HTTP status where known) so provider behavior stays observable without
   * parsing messages.
   */
  providerDetail?: {
    kind?: string;
    httpStatus?: number;
    /** "none" when the request never left; "unknown" when consumption is possible. */
    usageDisposition?: "none" | "unknown";
  };
};

export function runtimeFailure(
  code: RuntimeFailureCode,
  message: string,
  options: {
    retryable?: boolean;
    providerDetail?: RuntimeFailure["providerDetail"];
  } = {},
): RuntimeFailure {
  return {
    code,
    message,
    retryable:
      options.retryable ??
      (code === "TIMEOUT" ||
        code === "RATE_LIMITED" ||
        code === "PROVIDER_UNAVAILABLE" ||
        code === "PROVIDER_ERROR"),
    providerDetail: options.providerDetail,
  };
}

const RETRYABLE_BY_DEFAULT: ReadonlySet<RuntimeFailureCode> = new Set([
  "TIMEOUT",
  "RATE_LIMITED",
  "PROVIDER_UNAVAILABLE",
  "PROVIDER_ERROR",
  "INTERNAL_ERROR",
]);

export function isRetryableFailure(failure: RuntimeFailure): boolean {
  return RETRYABLE_BY_DEFAULT.has(failure.code);
}

/** Shape guard — used by consumers instead of message matching. */
export function isRuntimeFailure(value: unknown): value is RuntimeFailure {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as { code?: unknown; message?: unknown };

  return (
    typeof candidate.code === "string" &&
    (RUNTIME_FAILURE_CODES as readonly string[]).includes(candidate.code) &&
    typeof candidate.message === "string"
  );
}

type ErrorLike = {
  kind?: string;
  status?: number;
  usageDisposition?: "none" | "unknown";
  message?: string;
  name?: string;
};

/**
 * Map any thrown value (LlmClientError, validation error, or unknown) onto
 * the taxonomy. Cancellation is NEVER reported as a provider failure: an
 * aborted run maps to CANCELLED regardless of what the transport threw.
 */
export function classifyThrownError(
  error: unknown,
  context: { cancelled?: boolean } = {},
): RuntimeFailure {
  const message = error instanceof Error ? error.message : String(error);
  const like = (error ?? {}) as ErrorLike;

  if (context.cancelled) {
    return runtimeFailure("CANCELLED", message, {
      retryable: false,
      providerDetail: like.kind
        ? {
            kind: like.kind,
            httpStatus: typeof like.status === "number" ? like.status : undefined,
            usageDisposition: like.usageDisposition,
          }
        : undefined,
    });
  }

  switch (like.kind) {
    case "cancelled":
      return runtimeFailure("CANCELLED", message, {
        retryable: false,
        providerDetail: {
          kind: like.kind,
          usageDisposition: like.usageDisposition,
        },
      });

    case "timeout":
      return runtimeFailure("TIMEOUT", message, {
        providerDetail: {
          kind: like.kind,
          usageDisposition: like.usageDisposition ?? "unknown",
        },
      });

    case "malformed_response":
      return runtimeFailure("INVALID_RESPONSE", message, {
        retryable: false,
        providerDetail: { kind: like.kind },
      });

    case "http": {
      const status = like.status;

      if (status === 429) {
        return runtimeFailure("RATE_LIMITED", message, {
          providerDetail: {
            kind: like.kind,
            httpStatus: status,
            usageDisposition: like.usageDisposition ?? "none",
          },
        });
      }

      if (status === 401 || status === 403) {
        return runtimeFailure("AUTHENTICATION_FAILED", message, {
          retryable: false,
          providerDetail: {
            kind: like.kind,
            httpStatus: status,
            usageDisposition: like.usageDisposition ?? "none",
          },
        });
      }

      if (status !== undefined && status >= 500) {
        return runtimeFailure("PROVIDER_UNAVAILABLE", message, {
          providerDetail: {
            kind: like.kind,
            httpStatus: status,
            usageDisposition: like.usageDisposition ?? "unknown",
          },
        });
      }

      return runtimeFailure("PROVIDER_ERROR", message, {
        retryable: false,
        providerDetail: {
          kind: like.kind,
          httpStatus: status,
          usageDisposition: like.usageDisposition ?? "none",
        },
      });
    }

    case "transport":
      return runtimeFailure("PROVIDER_UNAVAILABLE", message, {
        providerDetail: {
          kind: like.kind,
          usageDisposition: like.usageDisposition ?? "unknown",
        },
      });

    default:
      return runtimeFailure("INTERNAL_ERROR", message, {
        providerDetail: like.kind ? { kind: like.kind } : undefined,
      });
  }
}

export function outcomeCodeForModelCall(
  failure: RuntimeFailure,
): import("@prisma/client").AiModelCallOutcome {
  switch (failure.code) {
    case "TIMEOUT":
      return "TIMEOUT";
    case "CANCELLED":
      return "CANCELLED";
    case "RATE_LIMITED":
      return "RATE_LIMITED";
    case "AUTHENTICATION_FAILED":
      return "AUTHENTICATION_FAILED";
    case "PROVIDER_UNAVAILABLE":
      return "PROVIDER_UNAVAILABLE";
    case "INVALID_RESPONSE":
      return "INVALID_RESPONSE";
    case "PROVIDER_ERROR":
      return "PROVIDER_ERROR";
    default:
      return "INTERNAL_ERROR";
  }
}
