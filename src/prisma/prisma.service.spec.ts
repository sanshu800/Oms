import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@prisma/client', () => import('../../test-utils/prisma-client.mock'));

import { PrismaService } from './prisma.service';
import { tenantContextStorage } from './tenant-context';

/**
 * These tests pin the behaviour of the row-level-security query
 * interception, which the mocked-model service tests cannot reach.
 *
 * The regression they exist for: Prisma hands extensions a *extended*
 * transaction client, so a hook that re-dispatches a query onto
 * `ctx.tx` lands back in the same hook with the same ambient context.
 * Without the `redirectedToTx` marker that is an infinite redirect
 * loop, and the process dies with an out-of-memory crash rather than a
 * readable error.
 */

type Hook = (input: {
  model: string;
  operation: string;
  args: unknown;
  query: (args: unknown) => Promise<unknown>;
}) => Promise<unknown>;

function hookOf(service: PrismaService): Hook {
  const extension = (service as unknown as { __extension: any }).__extension;
  return extension.query.$allModels.$allOperations as Hook;
}

describe('PrismaService RLS interception', () => {
  beforeEach(() => {
    process.env.APP_DATABASE_URL =
      'postgresql://techmart_app:secret@localhost:5432/techmart';
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('runs a query untouched when there is no ambient context', async () => {
    const service = new PrismaService();
    const query = vi.fn(async () => 'raw-result');

    const result = await hookOf(service)({
      model: 'Order',
      operation: 'findFirst',
      args: { where: { id: 'order-1' } },
      query,
    });

    expect(result).toBe('raw-result');
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('stamps the tenant id inside a transaction for bare tenant-scoped queries', async () => {
    const service = new PrismaService();
    const executed: string[] = [];
    const hook = hookOf(service);

    const mutable = service as unknown as {
      $executeRawUnsafe: (sql: string, ...args: unknown[]) => Promise<number>;
      order: { findMany: (args: unknown) => Promise<unknown> };
    };

    // The mock's $transaction hands back the same client, so the delegate
    // is reachable directly and the recorded set_config calls prove the
    // transaction wrapping happened before the query ran.
    mutable.$executeRawUnsafe = async (sql: string) => {
      executed.push(sql);
      return 0;
    };
    mutable.order = { findMany: vi.fn(async () => 'scoped-result') };

    const result = await tenantContextStorage.run({ tenantId: 'tenant-1' }, () =>
      hook({
        model: 'Order',
        operation: 'findMany',
        args: {},
        query: async () => 'unscoped-result',
      }),
    );

    expect(result).toBe('scoped-result');
    expect(mutable.order.findMany).toHaveBeenCalledTimes(1);
    expect(executed.some((sql) => sql.includes("set_config('app.tenant_id'"))).toBe(
      true,
    );
  });

  it('redirects a root-client query into an open transaction exactly once', async () => {
    const service = new PrismaService();
    const hook = hookOf(service);
    const args = { where: { id: 'order-1' } };

    // A transaction client is itself extended: when the hook dispatches
    // onto it, the hook runs again with the same query. Counting those
    // re-entries is what makes an infinite redirect loop visible.
    let reentries = 0;

    const txClient = {
      order: {
        findFirst: vi.fn(async (receivedArgs: unknown) => {
          reentries += 1;
          if (reentries > 3) {
            throw new Error('redirect loop: the hook re-dispatched onto itself');
          }
          return hook({
            model: 'Order',
            operation: 'findFirst',
            args: receivedArgs,
            query: async () => 'tx-bound-result',
          });
        }),
      },
    };

    const result = await tenantContextStorage.run(
      { tenantId: 'tenant-1', tx: txClient },
      () =>
        hook({
          model: 'Order',
          operation: 'findFirst',
          args,
          query: async () => 'root-client-result',
        }),
    );

    expect(result).toBe('tx-bound-result');
    expect(txClient.order.findFirst).toHaveBeenCalledTimes(1);
    expect(txClient.order.findFirst).toHaveBeenCalledWith(args);

    // The marker must not leak into the ambient context that opened the
    // transaction: the next root-client call has to redirect again.
    expect(tenantContextStorage.getStore()?.redirectedToTx).toBeUndefined();
  });
});
