/**
 * seed-lab-db.ts — reproducible lab seed for a fresh database provision.
 *
 * One command that takes a freshly provisioned PostgreSQL database (roles
 * and empty database already created) to the exact lab state the real-DB
 * acceptance suites expect, using ONLY the existing seed conventions:
 *
 *   1. `npx prisma migrate deploy`               — apply the committed migrations
 *   2. app-role grants (techmart_app)            — the RLS role the services
 *      run as needs table/sequence privileges (provision step, idempotent)
 *   3. `connect-shopify-store.ts --skip-verify`  — upsert the lab store
 *      connection (fake token, NO live Shopify calls; --skip-verify)
 *   4. `map-shopify-sku.ts --sku=sku-managed-1`  — the managed SKU (with
 *      initial stock) + default inventory location that
 *      inventory-truth / order-failure-exception / the AI suites require
 *
 * The CLIs are idempotent (upsert / update-or-create), so this script can
 * be re-run safely. It invents no production data and bypasses no
 * validation — every data row is created through the same CLI code paths
 * used for a real store.
 *
 * Environment-specific provisioning (initdb / roles) is documented in the
 * acceptance report. Expected .env contract = .env.example (DATABASE_URL as
 * the migration/superuser role, APP_DATABASE_URL as the RLS app role).
 *
 * Usage:
 *   npx ts-node seed-lab-db.ts
 */

import { execFileSync } from "node:child_process";

// Load .env so DATABASE_URL is available for the grant step.
 
const dotenv = require("dotenv") as { config: () => unknown };
dotenv.config();

const LAB_SHOP = "techmart-lab.myshopify.com";
const LAB_SKU = "sku-managed-1";

const APP_ROLE_GRANTS = [
  "GRANT USAGE ON SCHEMA public TO techmart_app",
  "GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO techmart_app",
  "GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO techmart_app",
  "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO techmart_app",
  "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE,SELECT ON SEQUENCES TO techmart_app",
];

function run(label: string, command: string, args: string[]): void {
  console.log(`\n[seed-lab-db] ${label}`);
  execFileSync(command, args, {
    stdio: ["ignore", "inherit", "inherit"],
    cwd: __dirname,
    env: process.env,
  });
}

async function applyAppRoleGrants(): Promise<void> {
  console.log("\n[seed-lab-db] granting app-role privileges (idempotent)");

  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error("DATABASE_URL is not set (see .env.example)");
  }

   
  const { Client } = require("pg") as {
    Client: new (config: { connectionString: string }) => {
      connect: () => Promise<void>;
      query: (text: string) => Promise<unknown>;
      end: () => Promise<void>;
    };
  };

  const client = new Client({ connectionString: databaseUrl });

  await client.connect();

  try {
    for (const statement of APP_ROLE_GRANTS) {
      await client.query(statement);
    }
  } finally {
    await client.end();
  }
}

async function main(): Promise<void> {
  run("applying committed migrations", "npx", ["prisma", "migrate", "deploy"]);

  await applyAppRoleGrants();

  run(
    "connecting the lab store (idempotent upsert, no live Shopify calls)",
    "npx",
    [
      "ts-node",
      "connect-shopify-store.ts",
      `--shop=${LAB_SHOP}`,
      "--token=shpat_lab_dummy_token",
      "--webhook-secret=lab-webhook-secret-000",
      "--label=lab store",
      "--skip-verify",
    ],
  );

  run(
    "seeding the managed SKU + default inventory location (idempotent)",
    "npx",
    [
      "ts-node",
      "map-shopify-sku.ts",
      `--shop=${LAB_SHOP}`,
      `--sku=${LAB_SKU}`,
      "--name=Managed SKU 1",
      "--qty=10",
    ],
  );

  console.log(
    "\n[seed-lab-db] DONE — lab seed applied. Run the six real-DB suites:",
  );
  for (const suite of [
    "ai-action-loop-real-db-test.ts",
    "ai-investigation-validation-run.ts",
    "shipping-foundation-real-db-test.ts",
    "wms-foundation-real-db-test.ts",
    "inventory-truth-real-db-test.ts",
    "order-failure-exception-real-db-test.ts",
  ]) {
    console.log(`  npx ts-node ${suite}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
