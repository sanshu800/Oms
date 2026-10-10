import {
  Injectable,
  Logger,
  UnprocessableEntityException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { StoreConnectionStatus, WmsProvider } from "@prisma/client";

import { PrismaService } from "../prisma/prisma.service";
import { encryptSecret } from "../shopify/shopify-auth.crypto";

export type CreateWmsConnectionInput = {
  tenantId: string;
  provider: WmsProvider;
  externalWarehouseId: string;
  locationId: string;
  /** Outbound API credential. Encrypted at rest; never returned or logged. */
  apiKey?: string;
  /** Inbound event signing secret. Encrypted at rest; never returned or logged. */
  webhookSecret?: string;
};

export type WmsConnectionView = {
  id: string;
  provider: WmsProvider;
  externalWarehouseId: string;
  locationId: string;
  status: StoreConnectionStatus;
  hasApiKey: boolean;
  hasWebhookSecret: boolean;
  connectedAt: Date | null;
  disconnectedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * Tenant-scoped WMS connection configuration.
 *
 * Credentials are encrypted with `encryptSecret` (AES-256-GCM under
 * ENCRYPTION_KEY) before they touch the database, and the view returned
 * to callers/APIs carries only `hasApiKey` / `hasWebhookSecret` booleans —
 * no secret material is ever returned or logged.
 */
@Injectable()
export class WmsConnectionService {
  private readonly logger = new Logger(WmsConnectionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async createConnection(
    input: CreateWmsConnectionInput,
  ): Promise<WmsConnectionView> {
    const externalWarehouseId = input.externalWarehouseId.trim();

    if (!externalWarehouseId) {
      throw new UnprocessableEntityException(
        "externalWarehouseId is required",
      );
    }

    const encryptionKey = this.config.get<string>("ENCRYPTION_KEY");

    if ((input.apiKey || input.webhookSecret) && !encryptionKey) {
      throw new UnprocessableEntityException(
        "ENCRYPTION_KEY is required to store WMS credentials",
      );
    }

    const encryptedApiKey = input.apiKey
      ? encryptSecret(input.apiKey, encryptionKey as string)
      : null;

    const encryptedWebhookSecret = input.webhookSecret
      ? encryptSecret(input.webhookSecret, encryptionKey as string)
      : null;

    const connection = await this.prisma.wmsConnection.create({
      data: {
        tenantId: input.tenantId,
        provider: input.provider,
        externalWarehouseId,
        locationId: input.locationId,
        status: StoreConnectionStatus.ACTIVE,
        encryptedApiKey,
        encryptedWebhookSecret,
        connectedAt: new Date(),
      },
    });

    // Ids and existence only — never the credential material.
    this.logger.log(
      `Created WMS connection ${connection.id} for warehouse ${connection.externalWarehouseId} (${connection.provider})`,
    );

    return toView(connection);
  }

  async listConnections(tenantId: string): Promise<WmsConnectionView[]> {
    const connections = await this.prisma.wmsConnection.findMany({
      where: { tenantId },
      orderBy: { createdAt: "asc" },
    });

    return connections.map(toView);
  }

  async getConnection(input: {
    tenantId: string;
    connectionId: string;
  }): Promise<WmsConnectionView | null> {
    const connection = await this.prisma.wmsConnection.findFirst({
      where: { id: input.connectionId, tenantId: input.tenantId },
    });

    return connection ? toView(connection) : null;
  }
}

function toView(connection: {
  id: string;
  provider: WmsProvider;
  externalWarehouseId: string;
  locationId: string;
  status: StoreConnectionStatus;
  encryptedApiKey: string | null;
  encryptedWebhookSecret: string | null;
  connectedAt: Date | null;
  disconnectedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}): WmsConnectionView {
  return {
    id: connection.id,
    provider: connection.provider,
    externalWarehouseId: connection.externalWarehouseId,
    locationId: connection.locationId,
    status: connection.status,
    hasApiKey: Boolean(connection.encryptedApiKey),
    hasWebhookSecret: Boolean(connection.encryptedWebhookSecret),
    connectedAt: connection.connectedAt,
    disconnectedAt: connection.disconnectedAt,
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt,
  };
}
