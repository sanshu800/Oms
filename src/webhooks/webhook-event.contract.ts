// This contract is intentionally immutable. Processing happens asynchronously after persistence.
export type ReceivedWebhookEvent = Readonly<{
  tenantId: string;
  storeId: string;
  topic: string;
  shopifyEventId: string;
  shopDomain: string;
  receivedAt: Date;
  rawPayload: Record<string, unknown>;
}>;
