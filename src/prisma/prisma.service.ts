import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";

import { createPrismaAdapter, databaseUrlFromEnv } from "./prisma-adapter";

import { tenantContextStorage } from "./tenant-context";

function uncapitalize(value: string): string {
  return value.charAt(0).toLowerCase() + value.slice(1);
}

/**
 * Every model query made through this service is RLS-aware, without
 * requiring every call site across the codebase to change. How:
 *
 * - No ambient context (scripts, health checks): query runs
 *   unscoped. FORCE ROW LEVEL SECURITY at the database level still
 *   applies — with no app.tenant_id/app.bypass_rls session var set,
 *   the policies deny every row rather than leaking anything.
 * - Ambient tenantId, no open transaction yet (the common case for a
 *   bare `this.prisma.model.find(...)` call): wrapped in its own
 *   short-lived transaction that stamps the session var first.
 * - Ambient tenantId AND an already-open transaction (registered by
 *   AllocationService/InventoryService's own explicit Serializable
 *   transactions, or by withTenant/withSystemBypass): reuse that
 *   exact transaction client instead of opening a second one — two
 *   independent interactive transactions on the same logical unit of
 *   work would otherwise contend for the same locks and deadlock.
 *
 * The constructor deliberately returns the *extended* client, not
 * `this` — Prisma's model-level interception only works through
 * $extends, and extends() produces a new object rather than mutating
 * the instance in place. Lifecycle hooks are copied onto that
 * returned object so Nest's OnModuleInit/OnModuleDestroy still fire.
 */
@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  // Type-only declarations — the real implementations are attached
  // at runtime, in the constructor, onto the extended client that
  // actually gets returned and injected everywhere. `declare` emits
  // no runtime field, so it never shadows that.
  declare runAsTenant: <T>(
    tenantId: string,
    fn: () => Promise<T>,
  ) => Promise<T>;

  declare runAsSystem: <T>(fn: () => Promise<T>) => Promise<T>;

  constructor() {
    // The app must connect as a restricted, non-superuser role for
    // RLS to mean anything — Postgres unconditionally exempts
    // superusers, FORCE or not. DATABASE_URL is reserved for
    // migrations (which need real DDL/ownership privileges);
    // APP_DATABASE_URL is what the running app actually queries
    // through.
    //
    // The client is generated with `engineType = "client"` (see
    // prisma/schema.prisma), so the connection must be provided by a
    // driver adapter — queries run through the WASM query compiler and
    // the `pg` protocol directly. That also means there is no native
    // query engine library to download at install time or ship in the
    // deployment artifact.
    const adapter = createPrismaAdapter(
      databaseUrlFromEnv(["APP_DATABASE_URL", "DATABASE_URL"]),
    );

    super({ adapter });

    const base = this;

    const extended = base.$extends({
      query: {
        $allModels: {
          async $allOperations({ model, operation, args, query }: any) {
            const ctx = tenantContextStorage.getStore();
            const delegateName = model ? uncapitalize(model) : undefined;

            if (process.env.RLS_DEBUG) {
              console.error("[RLS_DEBUG]", {
                model,
                operation,
                delegateName,
                hasContext: Boolean(ctx),
                hasTx: Boolean(ctx?.tx),
                redirectedToTx: Boolean(ctx?.redirectedToTx),
              });
            }

            if (!ctx) {
              return query(args);
            }

            if (ctx.tx) {
              if (!delegateName) return query(args);

              // The transaction client Prisma hands to $transaction
              // callbacks is itself extended, so calling straight
              // through it would land back in this same hook — with
              // the same ambient context (tx included) — and recurse
              // until the process runs out of memory. The nested
              // context marks that single re-dispatch; anything it
              // triggers now runs `query(args)` on the transaction
              // client, which is the connection the RLS session
              // variables were stamped on.
              if (ctx.redirectedToTx) {
                return query(args);
              }

              // The `await` is load-bearing: Prisma model calls are lazy
              // thenables, so a bare `return tx.model.op(args)` would hand
              // the thenable back to the caller and the operation would not
              // actually dispatch until it is awaited outside this run()
              // window — by which point the marker context is gone and the
              // hook redirects into itself forever.
              return tenantContextStorage.run(
                { ...ctx, redirectedToTx: true },
                async () => (ctx.tx as any)[delegateName][operation](args),
              );
            }

            return base.$transaction(async (tx) => {
              if (ctx.bypass) {
                await tx.$executeRawUnsafe(
                  `SELECT set_config('app.bypass_rls', 'on', true)`,
                );
              }

              if (ctx.tenantId) {
                await tx.$executeRawUnsafe(
                  `SELECT set_config('app.tenant_id', $1, true)`,
                  ctx.tenantId,
                );
              }

              if (!delegateName) return query(args);
              return (tx as any)[delegateName][operation](args);
            });
          },
        },
      },
    });

    (extended as any).onModuleInit = () => base.$connect();
    (extended as any).onModuleDestroy = () => base.$disconnect();

    // Prisma model calls (e.g. `.create(args)`) are lazy thenables —
    // they don't actually dispatch until awaited/`.then()`'d. If `fn`
    // merely *returns* one without awaiting it internally, the real
    // dispatch happens outside tenantContextStorage.run()'s window
    // (which only covers the synchronous extent of invoking fn, plus
    // whatever fn itself awaits inside it) and the ambient tenant
    // context would silently be gone by the time the query actually
    // runs. Awaiting fn() *inside* the run() callback, regardless of
    // how the caller wrote it, keeps this correct either way.
    (extended as any).runAsTenant = async <T>(
      tenantId: string,
      fn: () => Promise<T>,
    ): Promise<T> => {
      return tenantContextStorage.run({ tenantId }, async () => fn());
    };

    (extended as any).runAsSystem = async <T>(fn: () => Promise<T>): Promise<T> => {
      return tenantContextStorage.run({ bypass: true }, async () => fn());
    };

    return extended as unknown as PrismaService;
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
