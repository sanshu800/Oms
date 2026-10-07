import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Ambient RLS context for the current async execution (one HTTP
 * request, one BullMQ job). `tx` is only present once an explicit
 * transaction has actually been opened for this context — bare calls
 * see tenantId/bypass but no tx yet, and open their own short-lived
 * transaction; calls already inside an open transaction (registered
 * by whichever code opened it) reuse that same tx instead of nesting
 * a second one, which would otherwise deadlock against the first.
 */
export type TenantRlsContext = {
  tenantId?: string;
  bypass?: boolean;
  tx?: unknown;
  /**
   * Set only on the nested context used while a query is being
   * re-dispatched onto an already-open transaction client. It tells
   * the interception hook "this call is already on the transaction",
   * which stops the hook from redirecting the same call again (the
   * transaction client is extended, so without this marker the
   * redirect would recurse until the process runs out of memory).
   */
  redirectedToTx?: boolean;
};

export const tenantContextStorage = new AsyncLocalStorage<TenantRlsContext>();

export function getTenantContext(): TenantRlsContext | undefined {
  return tenantContextStorage.getStore();
}
