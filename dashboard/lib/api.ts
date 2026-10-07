const API_URL =
  process.env.NEXT_PUBLIC_API_URL?.replace(/\/+$/, "") ?? "http://localhost:4000";

const KEY_STORAGE_KEY = "techmart_api_key";

export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function getStoredApiKey(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(KEY_STORAGE_KEY);
}

export function setStoredApiKey(key: string): void {
  window.localStorage.setItem(KEY_STORAGE_KEY, key);
}

export function clearStoredApiKey(): void {
  window.localStorage.removeItem(KEY_STORAGE_KEY);
}

async function request<T>(
  path: string,
  options: { method?: string; body?: unknown; apiKey?: string | null } = {},
): Promise<T> {
  const apiKey = options.apiKey ?? getStoredApiKey();

  const response = await fetch(`${API_URL}${path}`, {
    method: options.method ?? "GET",
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });

  if (!response.ok) {
    let message = `Request failed with status ${response.status}`;

    try {
      const errorBody = (await response.json()) as { message?: string | string[] };
      if (errorBody.message) {
        message = Array.isArray(errorBody.message)
          ? errorBody.message.join(", ")
          : errorBody.message;
      }
    } catch {
      // response wasn't JSON — keep the generic message
    }

    throw new ApiError(response.status, message);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

// ---- Types ----

export type Store = {
  id: string;
  platform: string;
  shopDomain: string;
  status: string;
  scopes: string[];
  installedAt: string | null;
};

export type MeResponse = {
  tenant: { id: string; name: string; createdAt: string } | null;
  stores: Store[];
};

export type OperationalException = {
  id: string;
  tenantId: string;
  storeId: string;
  category: string;
  severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  status: "OPEN" | "INVESTIGATING" | "RESOLVED";
  title: string;
  fingerprint: string;
  evidence: Record<string, unknown>;
  recommendedNextStep: string;
  detectedAt: string;
  updatedAt: string;
  resolvedAt: string | null;
};

export type AiToolCall = {
  id: string;
  sequence: number;
  toolName: string;
  input: Record<string, unknown>;
  output: unknown;
  createdAt: string;
};

export type AiInvestigation = {
  id: string;
  status: "RUNNING" | "COMPLETED" | "FAILED";
  model: string;
  toolCallCount: number;
  tokensUsed: number | null;
  startedAt: string;
  completedAt: string | null;
  error: string | null;
  toolCalls: AiToolCall[];
};

export type AiOutcomeFeedback = {
  id: string;
  outcome: "APPROVED" | "REJECTED" | "EDITED";
  actorId: string | null;
  note: string | null;
  createdAt: string;
};

export type AiDecisionProposal = {
  id: string;
  exceptionId: string;
  investigationId: string;
  actionType: string;
  targetEntityType: string;
  targetEntityId: string;
  params: Record<string, unknown>;
  confidence: number;
  basis: "TENANT_HISTORY" | "POOLED_PRIOR" | "HEURISTIC";
  riskTier: "LOW" | "MEDIUM" | "HIGH";
  reasoningSummary: string;
  evidenceRefs: string[];
  status: "PROPOSED" | "APPROVED" | "REJECTED" | "EXECUTED" | "EXECUTION_FAILED";
  createdAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  investigation?: AiInvestigation;
  feedback?: AiOutcomeFeedback[];
  exception?: {
    title: string;
    category: string;
    severity: string;
    status: string;
  };
};

export type AutonomyPolicy = {
  id: string;
  tenantId: string;
  actionType: string;
  autonomyLevel: "RECOMMEND_ONLY" | "AUTO_BELOW_THRESHOLD";
  confidenceThreshold: number;
  maxActionsPerHour: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type InvestigationContext = {
  exception: OperationalException;
  order: {
    id: string;
    orderNumber: string;
    status: string;
    paymentStatus: string;
    fulfillmentStatus: string;
    currency: string;
    totalAmount: string;
    orderedAt: string;
  } | null;
  affectedItem: {
    id: string;
    sku: string;
    title: string;
    quantity: number;
    inventoryItemId: string | null;
  } | null;
  inventory: {
    sku: string;
    name: string;
    availableQty: number;
    reservedQty: number;
    committedQty: number;
    onHandQty: number;
    isStale: boolean;
    locations: Array<{
      locationName: string;
      locationCode: string;
      availableQty: number;
      reservedQty: number;
      committedQty: number;
    }>;
  } | null;
  reservations: Array<{ id: string; locationId: string; quantity: number; status: string }>;
};

// ---- API surface ----

export const api = {
  async validateKey(apiKey: string): Promise<MeResponse> {
    return request<MeResponse>("/me", { apiKey });
  },

  async me(): Promise<MeResponse> {
    return request<MeResponse>("/me");
  },

  async listExceptions(input: {
    storeId: string;
    status?: string;
    severity?: string;
  }): Promise<{ count: number; exceptions: OperationalException[] }> {
    const params = new URLSearchParams({ storeId: input.storeId });
    if (input.status) params.set("status", input.status);
    if (input.severity) params.set("severity", input.severity);
    return request(`/oms/exceptions?${params.toString()}`);
  },

  async getInvestigationContext(input: {
    exceptionId: string;
    storeId: string;
  }): Promise<InvestigationContext> {
    const params = new URLSearchParams({ storeId: input.storeId });
    return request(`/oms/exceptions/${input.exceptionId}/investigation?${params.toString()}`);
  },

  async getExceptionProposals(input: {
    exceptionId: string;
    storeId: string;
  }): Promise<{ count: number; proposals: AiDecisionProposal[] }> {
    const params = new URLSearchParams({ storeId: input.storeId });
    return request(`/ai/exceptions/${input.exceptionId}/proposals?${params.toString()}`);
  },

  async listProposals(input: {
    storeId: string;
    status?: string;
  }): Promise<{ count: number; proposals: AiDecisionProposal[] }> {
    const params = new URLSearchParams({ storeId: input.storeId });
    if (input.status) params.set("status", input.status);
    return request(`/ai/proposals?${params.toString()}`);
  },

  async approveProposal(input: {
    proposalId: string;
    storeId: string;
    actorId: string;
    note?: string;
  }) {
    return request(`/ai/proposals/${input.proposalId}/approve`, {
      method: "POST",
      body: { storeId: input.storeId, actorId: input.actorId, note: input.note },
    });
  },

  async rejectProposal(input: {
    proposalId: string;
    storeId: string;
    actorId: string;
    note?: string;
  }) {
    return request(`/ai/proposals/${input.proposalId}/reject`, {
      method: "POST",
      body: { storeId: input.storeId, actorId: input.actorId, note: input.note },
    });
  },

  async listAutonomyPolicies(): Promise<AutonomyPolicy[]> {
    return request(`/ai/autonomy-policies`);
  },

  async upsertAutonomyPolicy(input: {
    actionType: string;
    autonomyLevel: string;
    confidenceThreshold: number;
    maxActionsPerHour: number;
    enabled: boolean;
  }): Promise<AutonomyPolicy> {
    return request(`/ai/autonomy-policies/${input.actionType}`, {
      method: "PUT",
      body: {
        autonomyLevel: input.autonomyLevel,
        confidenceThreshold: input.confidenceThreshold,
        maxActionsPerHour: input.maxActionsPerHour,
        enabled: input.enabled,
      },
    });
  },
};
