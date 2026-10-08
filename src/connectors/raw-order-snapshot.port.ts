/**
 * Neutral persistence port for channel raw-order snapshots (stage D of the
 * connector-boundary refactor).
 *
 * `ChannelConnector.recordRawSnapshot` produces the snapshot; how it is
 * stored is infrastructure, not channel logic. Connectors depend on this
 * port only — never on Prisma or any other persistence mechanism. The
 * Prisma-backed implementation lives in prisma-raw-order-snapshot.store.ts
 * and is wired in ConnectorsModule.
 */

export type RawOrderSnapshotRecord = {
  tenantId: string;
  storeId: string;
  /** The order's identity on the channel. */
  externalOrderId: string;
  /** Channel-side order name/number as captured, with documented fallback. */
  orderName: string;
  financialStatus: string;
  fulfillmentStatus: string;
  /** The raw channel payload exactly as delivered. */
  rawPayload: unknown;
  /** Order timestamps as they appeared on the channel's payload. */
  externalCreatedAt: Date;
  externalUpdatedAt: Date;
};

/**
 * Idempotent write keyed on (store, channel order id): a redelivered or
 * updated order overwrites the earlier snapshot record.
 */
export interface RawOrderSnapshotStore {
  upsert(record: RawOrderSnapshotRecord): Promise<void>;
}

/** DI token for the raw order snapshot store. */
export const RAW_ORDER_SNAPSHOT_STORE = Symbol("RAW_ORDER_SNAPSHOT_STORE");
