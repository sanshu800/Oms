import { Injectable } from "@nestjs/common";
import { createHash, randomBytes } from "crypto";

import { PrismaService } from "../prisma/prisma.service";

const KEY_PREFIX = "tmk_";

/**
 * The only mechanism by which an HTTP caller is trusted to act as a
 * given tenant. Raw keys are never stored — only a sha256 hash, so a
 * database read alone can never recover a usable key. A caller
 * proves who they are by presenting the raw key once; after that,
 * every protected endpoint resolves tenantId from this, never from
 * anything the client claims in a query/body param.
 */
@Injectable()
export class TenantApiKeyService {
  constructor(private readonly prisma: PrismaService) {}

  async issueKey(input: {
    tenantId: string;
    label: string;
  }): Promise<{ id: string; rawKey: string }> {
    const rawKey = `${KEY_PREFIX}${randomBytes(32).toString("hex")}`;

    const created = await this.prisma.tenantApiKey.create({
      data: {
        tenantId: input.tenantId,
        label: input.label,
        hashedKey: this.hash(rawKey),
      },
    });

    return { id: created.id, rawKey };
  }

  /**
   * Returns the tenantId the key belongs to, or null if the key is
   * unknown, malformed, or has been revoked. Never throws — callers
   * (the guard) decide what an invalid key means for the request.
   */
  async resolveTenantId(rawKey: string): Promise<string | null> {
    if (!rawKey || !rawKey.startsWith(KEY_PREFIX)) {
      return null;
    }

    // Which tenant this key belongs to is exactly what we're
    // resolving — inherently runs before any tenant context exists.
    const record = await this.prisma.runAsSystem(() =>
      this.prisma.tenantApiKey.findUnique({
        where: { hashedKey: this.hash(rawKey) },
      }),
    );

    if (!record || record.revokedAt) {
      return null;
    }

    return record.tenantId;
  }

  async revokeKey(input: { id: string; tenantId: string }): Promise<void> {
    await this.prisma.tenantApiKey.updateMany({
      where: { id: input.id, tenantId: input.tenantId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async listKeys(input: { tenantId: string }) {
    return this.prisma.tenantApiKey.findMany({
      where: { tenantId: input.tenantId },
      select: {
        id: true,
        label: true,
        createdAt: true,
        revokedAt: true,
      },
      orderBy: { createdAt: "desc" },
    });
  }

  private hash(rawKey: string): string {
    return createHash("sha256").update(rawKey, "utf8").digest("hex");
  }
}
