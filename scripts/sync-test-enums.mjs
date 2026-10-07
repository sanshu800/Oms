#!/usr/bin/env node
/**
 * Regenerates the enum exports in `test-utils/prisma-client.mock.ts` from
 * `prisma/schema.prisma`.
 *
 * Why this exists: unit tests mock `@prisma/client`, so production code that
 * imports an enum gets `undefined` unless the mock declares it — and
 * `undefined` comparisons silently take the wrong branch instead of failing
 * loudly. That happened once already: a missing `StoreConnectionStatus`
 * made every store look disconnected and broke eight unrelated tests.
 * Deriving the values from the schema removes the drift by construction.
 *
 * Usage:
 *   node scripts/sync-test-enums.mjs          # rewrite the mock
 *   node scripts/sync-test-enums.mjs --check  # exit 1 if out of date (CI)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const schemaPath = path.join(projectRoot, "prisma", "schema.prisma");
const mockPath = path.join(projectRoot, "test-utils", "prisma-client.mock.ts");

const START = "// <generated-enums>";
const END = "// </generated-enums>";

function parseEnums(schema) {
  const enums = new Map();
  const enumBlock = /^enum\s+(\w+)\s*\{([\s\S]*?)^\}/gm;

  for (const match of schema.matchAll(enumBlock)) {
    const [, name, body] = match;
    const values = body
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("//") && !line.startsWith("///"))
      .map((line) => line.split(/\s+/)[0])
      .filter((value) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(value));

    enums.set(name, values);
  }

  return enums;
}

function renderEnumSection(enums) {
  const blocks = [];

  for (const [name, values] of enums) {
    const entries = values.map((value) => `  ${value}: "${value}",`).join("\n");
    blocks.push(`export const ${name} = {\n${entries}\n} as const;`);
  }

  return blocks.join("\n\n");
}

const schema = readFileSync(schemaPath, "utf8");
const mock = readFileSync(mockPath, "utf8");

const enums = parseEnums(schema);

if (enums.size === 0) {
  console.error("No enums found in prisma/schema.prisma — refusing to rewrite the mock.");
  process.exit(1);
}

const startIndex = mock.indexOf(START);
const endIndex = mock.indexOf(END);

if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
  console.error(
    `Could not find the generated-enum markers in ${path.relative(projectRoot, mockPath)}.`,
  );
  process.exit(1);
}

const generated = `${START}\n// Generated from prisma/schema.prisma by scripts/sync-test-enums.mjs.\n// Do not edit by hand; run \`npm run test-utils:sync\` instead.\n${renderEnumSection(enums)}\n${END}`;

const updated = mock.slice(0, startIndex) + generated + mock.slice(endIndex + END.length);
const isCheck = process.argv.includes("--check");

if (isCheck) {
  if (updated !== mock) {
    console.error(
      "test-utils/prisma-client.mock.ts is out of date with prisma/schema.prisma. Run `npm run test-utils:sync`.",
    );
    process.exit(1);
  }

  console.log(`Prisma test mock enums are in sync (${enums.size} enums).`);
  process.exit(0);
}

if (updated === mock) {
  console.log(`Already in sync (${enums.size} enums).`);
  process.exit(0);
}

writeFileSync(mockPath, updated);
console.log(`Updated ${path.relative(projectRoot, mockPath)} with ${enums.size} enums.`);
