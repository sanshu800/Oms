// This contract is intentionally immutable. Processing happens asynchronously after persistence.
export type ReceivedWebhookEvent = Readonly<{
  tenantId: string;
  storeId: string;
  topic: string;
  /** The channel's id for this delivery (locked decision 6). */
  externalEventId: string;
  /** The channel's name for the sending store (StoreConnection.externalStoreId). */
  storeKey: string;
  receivedAt: Date;
  rawPayload: Record<string, unknown>;
}>;
