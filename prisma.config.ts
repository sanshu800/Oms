import { existsSync } from "node:fs";
import path from "node:path";

import { PrismaPg } from "@prisma/adapter-pg";
import { config as loadEnvFile } from "dotenv";
import { defineConfig } from "prisma/config";

/**
 * Prisma CLI configuration.
 *
 * Two things here exist specifically so the schema and client can be
 * generated and migrated without any prebuilt engine binary being
 * downloaded from `binaries.prisma.sh`:
 *
 * 1. `engine: "js"` selects Prisma's JavaScript schema engine, which
 *    runs in-process on WebAssembly and talks to Postgres through the
 *    `pg` driver adapter below. The legacy "classic" engine is a native
 *    Rust binary that the CLI fetches over the network on first use.
 * 2. The generated client is configured (in `prisma/schema.prisma`)
 *    with `engineType = "client"`, so runtime queries go through the
 *    same WASM query compiler plus the `pg` driver instead of the
 *    native query engine library.
 *
 * Net effect: `prisma generate`, `prisma migrate` and `prisma db push`
 * work in air-gapped/CI environments and produce a deployment artifact
 * with no Rust engine shared objects to ship.
 */

// The Prisma CLI no longer loads `.env` automatically once a config
// file is present, so load it here (existing values always win).
const projectRoot = typeof __dirname === "string" ? __dirname : process.cwd();

for (const envFile of [".env", ".env.local"]) {
  const envPath = path.join(projectRoot, envFile);
  if (existsSync(envPath)) {
    loadEnvFile({ path: envPath, override: false, quiet: true });
  }
}

/**
 * Schema/migration commands need a role that can run DDL, which is what
 * `DATABASE_URL` is reserved for. `APP_DATABASE_URL` is the restricted
 * runtime role and is intentionally not used here.
 */
function migrationConnectionString(): string {
  const url = process.env.DATABASE_URL ?? process.env.APP_DATABASE_URL;

  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. Copy .env.example to .env (or export DATABASE_URL) before running Prisma CLI commands.",
    );
  }

  return url;
}

export default defineConfig({
  schema: path.join("prisma", "schema.prisma"),
  migrations: {
    path: path.join("prisma", "migrations"),
  },
  // Driver adapters with the JavaScript schema engine are still gated
  // behind an explicit experimental flag in Prisma 6.x.
  experimental: {
    adapter: true,
  },
  engine: "js",
  adapter: async () =>
    new PrismaPg({ connectionString: migrationConnectionString() }),
});
