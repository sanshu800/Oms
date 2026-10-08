import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { StoreConnectionStatus, StorePlatform } from "@prisma/client";

import { PrismaService } from "../../prisma/prisma.service";
import { decryptSecret } from "../../shopify/shopify-auth.crypto";
import {
  ActionAdapter,
  ActionAdapterInput,
  ActionAdapterResult,
} from "./action-adapter.interface";

const SHOPIFY_API_VERSION = "2026-07";
const REQUIRED_WRITE_SCOPE = "write_orders";
const SUPPORTED_ACTIONS = ["ADD_ORDER_NOTE"];

type ShopifyGraphQlResponse<T> = {
  data?: T;
  errors?: Array<{ message: string }>;
};

type OrderUpdateResponse = {
  orderUpdate: {
    order: { id: string; note: string | null } | null;
    userErrors: Array<{ field: string[]; message: string }>;
  };
};

type OrderNoteQueryResponse = {
  order: { id: string; note: string | null } | null;
};

/**
 * First real cross-system actuation adapter: Shopify, via its GraphQL
 * Admin API (matching the codebase's existing convention in
 * ShopifyInventoryService — GraphQL, not REST). Phase 8 ships exactly
 * one write action (ADD_ORDER_NOTE) deliberately: it's fully
 * reversible and touches nothing financial or fulfillment-related,
 * making it the lowest-risk possible proof that the actuation
 * pathway works end-to-end against a real store.
 */
@Injectable()
export class ShopifyActionAdapter implements ActionAdapter {
  readonly platform = StorePlatform.SHOPIFY;

  private readonly logger = new Logger(ShopifyActionAdapter.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  supports(actionType: string): boolean {
    return SUPPORTED_ACTIONS.includes(actionType);
  }

  async execute(input: ActionAdapterInput): Promise<ActionAdapterResult> {
    if (!this.supports(input.actionType)) {
      return {
        success: false,
        raw: { error: `Unsupported actionType for Shopify: ${input.actionType}` },
      };
    }

    if (input.targetEntityType !== "ORDER") {
      return {
        success: false,
        raw: {
          error: `${input.actionType} requires targetEntityType ORDER, got ${input.targetEntityType}`,
        },
      };
    }

    const note = typeof input.params.note === "string" ? input.params.note.trim() : "";

    if (!note) {
      return {
        success: false,
        raw: { error: "params.note is required and must be a non-empty string" },
      };
    }

    let resolved: Awaited<ReturnType<typeof this.resolveStore>>;

    try {
      resolved = await this.resolveStore(input.tenantId, input.storeId);
    } catch (error) {
      return {
        success: false,
        raw: { error: error instanceof Error ? error.message : String(error) },
      };
    }

    const order = await this.prisma.order.findFirst({
      where: {
        id: input.targetEntityId,
        tenantId: input.tenantId,
        storeId: input.storeId,
      },
      select: { externalOrderId: true },
    });

    if (!order) {
      return { success: false, raw: { error: "Order not found in this tenant/store" } };
    }

    const gid = toOrderGid(order.externalOrderId);

    const mutation = `
      mutation TechMartAddOrderNote($input: OrderInput!) {
        orderUpdate(input: $input) {
          order { id note }
          userErrors { field message }
        }
      }
    `;

    const response = await this.graphQl<OrderUpdateResponse>(
      resolved.shopDomain,
      resolved.accessToken,
      mutation,
      { input: { id: gid, note } },
    );

    const userErrors = response.data?.orderUpdate?.userErrors ?? [];

    if (response.errors?.length || userErrors.length > 0) {
      this.logger.warn(
        `Shopify orderUpdate failed for order ${gid}: ${JSON.stringify(
          response.errors ?? userErrors,
        )}`,
      );

      return { success: false, raw: response };
    }

    return {
      success: true,
      externalReference: response.data?.orderUpdate.order?.id,
      raw: response,
    };
  }

  async verify(input: ActionAdapterInput): Promise<boolean> {
    if (input.targetEntityType !== "ORDER") {
      return false;
    }

    const expectedNote = typeof input.params.note === "string" ? input.params.note.trim() : "";

    if (!expectedNote) {
      return false;
    }

    let resolved: Awaited<ReturnType<typeof this.resolveStore>>;

    try {
      resolved = await this.resolveStore(input.tenantId, input.storeId);
    } catch {
      return false;
    }

    const order = await this.prisma.order.findFirst({
      where: {
        id: input.targetEntityId,
        tenantId: input.tenantId,
        storeId: input.storeId,
      },
      select: { externalOrderId: true },
    });

    if (!order) {
      return false;
    }

    const gid = toOrderGid(order.externalOrderId);

    const query = `
      query TechMartOrderNoteCheck($id: ID!) {
        order(id: $id) { id note }
      }
    `;

    const response = await this.graphQl<OrderNoteQueryResponse>(
      resolved.shopDomain,
      resolved.accessToken,
      query,
      { id: gid },
    );

    // Independently re-read Shopify's own record of the note — do not
    // trust execute()'s own success flag alone.
    return response.data?.order?.note === expectedNote;
  }

  private async resolveStore(tenantId: string, storeId: string) {
    const store = await this.prisma.storeConnection.findFirst({
      where: {
        id: storeId,
        tenantId,
        platform: StorePlatform.SHOPIFY,
        status: StoreConnectionStatus.ACTIVE,
      },
    });

    if (!store) {
      throw new Error("Active Shopify store connection not found");
    }

    if (!store.encryptedAccessToken) {
      throw new Error("Shopify access token missing for this store");
    }

    if (!store.scopes.includes(REQUIRED_WRITE_SCOPE)) {
      throw new Error(
        `Shopify write scope '${REQUIRED_WRITE_SCOPE}' has not been granted for this store — the merchant must complete the write-access consent flow before this action can execute.`,
      );
    }

    const encryptionKey = this.config.get<string>("ENCRYPTION_KEY");

    if (!encryptionKey) {
      throw new Error("ENCRYPTION_KEY is not configured");
    }

    const accessToken = decryptSecret(store.encryptedAccessToken, encryptionKey);

    return { shopDomain: store.externalStoreId, accessToken };
  }

  private async graphQl<T>(
    shopDomain: string,
    accessToken: string,
    query: string,
    variables: Record<string, unknown>,
  ): Promise<ShopifyGraphQlResponse<T>> {
    const response = await fetch(
      `https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": accessToken,
        },
        body: JSON.stringify({ query, variables }),
      },
    );

    const result = (await response.json()) as ShopifyGraphQlResponse<T>;

    if (!response.ok) {
      return {
        errors: [
          { message: `Shopify request failed with HTTP ${response.status}` },
        ],
      };
    }

    return result;
  }
}

function toOrderGid(externalOrderId: string): string {
  if (externalOrderId.startsWith("gid://")) {
    return externalOrderId;
  }

  return `gid://shopify/Order/${externalOrderId}`;
}
