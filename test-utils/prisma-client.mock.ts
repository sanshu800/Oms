class MockDecimal {
  private readonly value: string;

  constructor(value: string | number) {
    this.value = String(value);
  }

  toString(): string {
    return this.value;
  }

  toJSON(): string {
    return this.value;
  }
}

export const Prisma = {
  Decimal: MockDecimal,
  TransactionIsolationLevel: { Serializable: "Serializable" },
};

/**
 * Minimal stand-in for PrismaClient so unit tests can run without the
 * generated client. `$extends` records the extension configuration so
 * tests can drive the RLS interception hook directly (see
 * src/prisma/prisma.service.spec.ts) — the query interception cannot be
 * exercised through a mocked model delegate alone.
 */
export const PrismaClient = class MockPrismaClient {
  __extension: any = undefined;

  $extends(extension?: unknown) {
    this.__extension = extension;
    return this;
  }

  async $connect() {
    return undefined;
  }

  async $disconnect() {
    return undefined;
  }

  async $executeRawUnsafe() {
    return 0;
  }

  async $transaction(callback: (tx: unknown) => unknown) {
    return callback(this);
  }
};

// <generated-enums>
// Generated from prisma/schema.prisma by scripts/sync-test-enums.mjs.
// Do not edit by hand; run `npm run test-utils:sync` instead.
export const StorePlatform = {
  SHOPIFY: "SHOPIFY",
  AMAZON: "AMAZON",
  WOOCOMMERCE: "WOOCOMMERCE",
  EBAY: "EBAY",
  OTHER: "OTHER",
} as const;

export const StoreConnectionStatus = {
  PENDING: "PENDING",
  ACTIVE: "ACTIVE",
  DISCONNECTED: "DISCONNECTED",
} as const;

export const WebhookStatus = {
  RECEIVED: "RECEIVED",
  PROCESSING: "PROCESSING",
  PROCESSED: "PROCESSED",
  FAILED: "FAILED",
  DEAD_LETTER: "DEAD_LETTER",
} as const;

export const OrderStatus = {
  NEW: "NEW",
  CONFIRMED: "CONFIRMED",
  PROCESSING: "PROCESSING",
  READY_TO_FULFILL: "READY_TO_FULFILL",
  FULFILLING: "FULFILLING",
  FULFILLED: "FULFILLED",
  CANCELLED: "CANCELLED",
  FAILED: "FAILED",
} as const;

export const ExceptionStatus = {
  OPEN: "OPEN",
  INVESTIGATING: "INVESTIGATING",
  RESOLVED: "RESOLVED",
} as const;

export const ExceptionSeverity = {
  CRITICAL: "CRITICAL",
  HIGH: "HIGH",
  MEDIUM: "MEDIUM",
  LOW: "LOW",
} as const;

export const AuditActorType = {
  SYSTEM: "SYSTEM",
  USER: "USER",
  INTEGRATION: "INTEGRATION",
  AI_AGENT: "AI_AGENT",
} as const;

export const AiInvestigationStatus = {
  RUNNING: "RUNNING",
  COMPLETED: "COMPLETED",
  FAILED: "FAILED",
} as const;

export const AiDecisionBasis = {
  TENANT_HISTORY: "TENANT_HISTORY",
  POOLED_PRIOR: "POOLED_PRIOR",
  HEURISTIC: "HEURISTIC",
} as const;

export const AiRiskTier = {
  LOW: "LOW",
  MEDIUM: "MEDIUM",
  HIGH: "HIGH",
} as const;

export const AiDecisionProposalStatus = {
  PROPOSED: "PROPOSED",
  APPROVED: "APPROVED",
  REJECTED: "REJECTED",
  EXECUTED: "EXECUTED",
  EXECUTION_FAILED: "EXECUTION_FAILED",
} as const;

export const AiOutcome = {
  APPROVED: "APPROVED",
  REJECTED: "REJECTED",
  EDITED: "EDITED",
} as const;

export const AiAutonomyLevel = {
  RECOMMEND_ONLY: "RECOMMEND_ONLY",
  AUTO_BELOW_THRESHOLD: "AUTO_BELOW_THRESHOLD",
} as const;

export const InventoryReservationStatus = {
  ACTIVE: "ACTIVE",
  RELEASED: "RELEASED",
  COMMITTED: "COMMITTED",
  SHIPPED: "SHIPPED",
} as const;

export const InventoryMovementType = {
  RECEIPT: "RECEIPT",
  ADJUSTMENT_IN: "ADJUSTMENT_IN",
  ADJUSTMENT_OUT: "ADJUSTMENT_OUT",
  RESERVATION: "RESERVATION",
  RELEASE: "RELEASE",
  COMMIT: "COMMIT",
  SHIP: "SHIP",
  TRANSFER_IN: "TRANSFER_IN",
  TRANSFER_OUT: "TRANSFER_OUT",
} as const;

export const FulfillmentStatus = {
  READY: "READY",
  IN_PROGRESS: "IN_PROGRESS",
  PARTIALLY_FULFILLED: "PARTIALLY_FULFILLED",
  FULFILLED: "FULFILLED",
  FAILED: "FAILED",
  CANCELLED: "CANCELLED",
} as const;

export const ShipmentStatus = {
  CREATED: "CREATED",
  LABEL_CREATED: "LABEL_CREATED",
  IN_TRANSIT: "IN_TRANSIT",
  DELIVERED: "DELIVERED",
  CANCELLED: "CANCELLED",
} as const;

export const WmsProvider = {
  FAKE: "FAKE",
} as const;

export const WmsRequestStatus = {
  PENDING: "PENDING",
  SUBMITTED: "SUBMITTED",
  ACKNOWLEDGED: "ACKNOWLEDGED",
  COMPLETED: "COMPLETED",
  FAILED: "FAILED",
  CANCELLED: "CANCELLED",
} as const;
// </generated-enums>
