import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const existing = await prisma.tenant.findFirst({
    where: {
      name: "TechMart Development",
    },
    select: {
      id: true,
      name: true,
    },
  });

  if (existing) {
    console.log(
      `Development tenant already exists: ${existing.name}`,
    );
    return;
  }

  const tenant = await prisma.tenant.create({
    data: {
      name: "TechMart Development",
    },
    select: {
      id: true,
      name: true,
    },
  });

  console.log(
    `Created development tenant: ${tenant.name}`,
  );
}

main()
  .catch((error) => {
    console.error("Development tenant bootstrap failed");
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
