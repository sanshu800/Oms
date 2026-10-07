import { PrismaClient } from "@prisma/client";

import { PrismaService } from "../prisma/prisma.service";
import { TenantApiKeyService } from "../auth/tenant-api-key.service";

const prisma = new PrismaClient();

async function main() {
  const tenantId = process.argv[2];
  const label = process.argv[3] ?? "manually issued key";

  if (!tenantId) {
    throw new Error(
      "Usage: create-tenant-api-key.ts <tenantId> [label]",
    );
  }

  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });

  if (!tenant) {
    throw new Error(`No tenant found with id ${tenantId}`);
  }

  // TenantApiKey has RLS enabled; this is a short-lived, single-purpose
  // admin script with its own dedicated connection (not the pooled app
  // process), so a plain session-level SET here is safe.
  await prisma.$executeRawUnsafe(`SET app.bypass_rls = 'on'`);

  const service = new TenantApiKeyService(prisma as unknown as PrismaService);
  const { rawKey } = await service.issueKey({ tenantId, label });

  console.log(
    `API key created for tenant "${tenant.name}" (${tenantId}).\n` +
      `Save this now — it cannot be shown again:\n\n${rawKey}\n`,
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
