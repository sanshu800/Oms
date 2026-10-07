import { PrismaPg } from "@prisma/adapter-pg";

/**
 * The generated client uses `engineType = "client"`
 * (see prisma/schema.prisma), which means every PrismaClient instance
 * must be given a driver adapter — there is no built-in native query
 * engine to fall back on. Centralising construction here keeps the
 * application and the standalone admin scripts in sync; without it a
 * script that does `new PrismaClient()` fails at startup with
 * "Using engine type 'client' requires a driver adapter".
 */

/**
 * Reads the first connection string that is actually set.
 *
 * `DATABASE_URL` is the schema-owner/migration role and bypasses row
 * level security; `APP_DATABASE_URL` is the restricted runtime role.
 * Callers choose the order deliberately:
 *
 * - the API (`PrismaService`) prefers `APP_DATABASE_URL` so RLS applies
 * - one-off admin scripts prefer `DATABASE_URL` because they need to
 *   legitimately cross tenant boundaries
 */
export function databaseUrlFromEnv(variableNames: string[]): string {
  for (const name of variableNames) {
    const value = process.env[name];
    if (value && value.trim().length > 0) {
      return value;
    }
  }

  throw new Error(
    `None of ${variableNames.join(", ")} is set; cannot open a database connection.`,
  );
}

export function createPrismaAdapter(connectionString: string): PrismaPg {
  return new PrismaPg({ connectionString });
}
