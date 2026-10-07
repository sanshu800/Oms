// Browser requests stay same-origin; Next.js proxies /api/* to the private
// backend using the server-only API_SERVER_URL setting.
const API_URL = "/api";

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


export type OrderStatus =
  | "NEW"
  | "CONFIRMED"
  | "PROCESSING"
  | "READY_TO_FULFILL"
  | "FULFILLING"
  | "FULFILLED"
  | "CANCELLED"
  | "FAILED";

export type Order = {
  id: string;
  tenantId: string;
  storeId: string;
  externalOrderId: string;
  orderNumber: string;
  status: OrderStatus;
  paymentStatus: string;
  fulfillmentStatus: string;
  totalAmount: string;
  currency: string;
  orderedAt: string;
  createdAt: string;
  updatedAt: string;
};

export type OrderLineItem = {
  id: string;
  externalLineItemId: string;
  inventoryItemId: string | null;
  sku: string;
  title: string;
  quantity: number;
  unitPrice: string | null;
};

export type InventoryReservation = {
  id: string;
  orderId: string;
  orderItemId: string;
  inventoryItemId: string;
  locationId: string;
  quantity: number;
  status: "ACTIVE" | "RELEASED" | "COMMITTED" | "SHIPPED";
  createdAt: string;
};

export type OrderDetails = Order & {
  items: OrderLineItem[];
  reservations: InventoryReservation[];
  fulfillments: Array<{
    id: string;
    status: string;
    items: Array<{ id: string; orderItemId: string; quantity: number }>;
    shipments: Array<{
      id: string;
      status: string;
      trackingNumber: string | null;
      carrier: string | null;
    }>;
  }>;
};

export type PaginatedResponse<T> = {
  items: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
};

export type InventoryBalance = {
  availableQty: number;
  reservedQty: number;
  committedQty: number;
  location: { id: string; name: string; code: string };
};

export type InventoryItem = {
  id: string;
  sku: string;
  name: string;
  active: boolean;
  balances: InventoryBalance[];
  externalReferences: Array<{
    id: string;
    platform: string;
    externalId: string;
  }>;
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

  async listOrders(input: {
    storeId: string;
    status?: string;
    page?: number;
    limit?: number;
  }): Promise<PaginatedResponse<Order>> {
    const params = new URLSearchParams({ storeId: input.storeId });
    if (input.status) params.set("status", input.status);
    if (input.page) params.set("page", String(input.page));
    if (input.limit) params.set("limit", String(input.limit));
    return request(`/oms/orders?${params.toString()}`);
  },

  async getOrder(input: {
    orderId: string;
    storeId: string;
  }): Promise<OrderDetails> {
    const params = new URLSearchParams({ storeId: input.storeId });
    return request(
      `/oms/orders/${encodeURIComponent(input.orderId)}?${params.toString()}`,
    );
  },

  async listInventory(input: {
    storeId: string;
    query?: string;
    page?: number;
    limit?: number;
  }): Promise<PaginatedResponse<InventoryItem>> {
    const params = new URLSearchParams({ storeId: input.storeId });
    if (input.query) params.set("q", input.query);
    if (input.page) params.set("page", String(input.page));
    if (input.limit) params.set("limit", String(input.limit));
    return request(`/oms/inventory?${params.toString()}`);
  },

  async getInventoryItem(input: {
    sku: string;
    storeId: string;
  }): Promise<InventoryItem> {
    const params = new URLSearchParams({ storeId: input.storeId });
    return request(
      `/oms/inventory/${encodeURIComponent(input.sku)}?${params.toString()}`,
    );
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
