import {
  Injectable,
  Logger,
  UnprocessableEntityException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ShippingProvider, StoreConnectionStatus } from "@prisma/client";

import { PrismaService } from "../prisma/prisma.service";
import { encryptSecret } from "../shopify/shopify-auth.crypto";

export type CreateShippingConnectionInput = {
  tenantId: string;
  provider: ShippingProvider;
  /** The provider-side account identity (e.g. the Shiprocket account). */
  externalAccountId: string;
  /** Outbound API credential. Encrypted at rest; never returned or logged. */
  apiKey?: string;
  /** Inbound event signing secret. Encrypted at rest; never returned or logged. */
  webhookSecret?: string;
};

export type ShippingConnectionView = {
  id: string;
  provider: ShippingProvider;
  externalAccountId: string;
  status: StoreConnectionStatus;
  hasApiKey: boolean;
  hasWebhookSecret: boolean;
  connectedAt: Date | null;
  disconnectedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * Tenant-scoped shipping connection configuration.
 *
 * Credentials are encrypted with `encryptSecret` (AES-256-GCM under
 * ENCRYPTION_KEY) before they touch the database, and the view returned
 * to callers/APIs carries only `hasApiKey` / `hasWebhookSecret` booleans —
 * no secret material is ever returned or logged.
 */
@Injectable()
export class ShippingConnectionService {
  private readonly logger = new Logger(ShippingConnectionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async createConnection(
    input: CreateShippingConnectionInput,
  ): Promise<ShippingConnectionView> {
    const externalAccountId = input.externalAccountId.trim();

    if (!externalAccountId) {
      throw new UnprocessableEntityException(
        "externalAccountId is required",
      );
    }

    const encryptionKey = this.config.get<string>("ENCRYPTION_KEY");

    if ((input.apiKey || input.webhookSecret) && !encryptionKey) {
      throw new UnprocessableEntityException(
        "ENCRYPTION_KEY is required to store shipping credentials",
      );
    }

    const encryptedApiKey = input.apiKey
      ? encryptSecret(input.apiKey, encryptionKey as string)
      : null;

    const encryptedWebhookSecret = input.webhookSecret
      ? encryptSecret(input.webhookSecret, encryptionKey as string)
      : null;

    const connection = await this.prisma.shippingConnection.create({
      data: {
        tenantId: input.tenantId,
        provider: input.provider,
        externalAccountId,
        status: StoreConnectionStatus.ACTIVE,
        encryptedApiKey,
        encryptedWebhookSecret,
        connectedAt: new Date(),
      },
    });

    // Ids and existence only — never the credential material.
    this.logger.log(
      `Created shipping connection ${connection.id} for account ${connection.externalAccountId} (${connection.provider})`,
    );

    return toView(connection);
  }

  async listConnections(tenantId: string): Promise<ShippingConnectionView[]> {
    const connections = await this.prisma.shippingConnection.findMany({
      where: { tenantId },
      orderBy: { createdAt: "asc" },
    });

    return connections.map(toView);
  }

  async getConnection(input: {
    tenantId: string;
    connectionId: string;
  }): Promise<ShippingConnectionView | null> {
    const connection = await this.prisma.shippingConnection.findFirst({
      where: { id: input.connectionId, tenantId: input.tenantId },
    });

    return connection ? toView(connection) : null;
  }
}

function toView(connection: {
  id: string;
  provider: ShippingProvider;
  externalAccountId: string;
  status: StoreConnectionStatus;
  encryptedApiKey: string | null;
  encryptedWebhookSecret: string | null;
  connectedAt: Date | null;
  disconnectedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}): ShippingConnectionView {
  return {
    id: connection.id,
    provider: connection.provider,
    externalAccountId: connection.externalAccountId,
    status: connection.status,
    hasApiKey: Boolean(connection.encryptedApiKey),
    hasWebhookSecret: Boolean(connection.encryptedWebhookSecret),
    connectedAt: connection.connectedAt,
    disconnectedAt: connection.disconnectedAt,
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt,
  };
}
