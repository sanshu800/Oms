import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { StoreConnectionStatus, StorePlatform } from "@prisma/client";

import { PrismaService } from "../prisma/prisma.service";
import { TenantApiKeyService } from "../auth/tenant-api-key.service";
import {
  createSignedState,
  encryptSecret,
  verifySignedState,
} from "./shopify-auth.crypto";
import {
  isValidShopDomain,
  verifyShopifyQueryHmac,
} from "./shopify-query-hmac";

type ShopifyTokenResponse = {
  access_token?: string;
  scope?: string;
};

@Injectable()
export class ShopifyAuthService {
  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly tenantApiKeyService: TenantApiKeyService,
  ) {}

  private get apiKey(): string {
    const value = this.config.get<string>("SHOPIFY_API_KEY");

    if (!value) {
      throw new InternalServerErrorException(
        "SHOPIFY_API_KEY is not configured",
      );
    }

    return value;
  }

  private get apiSecret(): string {
    const value = this.config.get<string>("SHOPIFY_API_SECRET");

    if (!value) {
      throw new InternalServerErrorException(
        "SHOPIFY_API_SECRET is not configured",
      );
    }

    return value;
  }

  private get encryptionKey(): string {
    const value = this.config.get<string>("ENCRYPTION_KEY");

    if (!value) {
      throw new InternalServerErrorException(
        "ENCRYPTION_KEY is not configured",
      );
    }

    return value;
  }

  private get appUrl(): string {
    const value = this.config.get<string>("APP_URL");

    if (!value) {
      throw new InternalServerErrorException(
        "APP_URL is not configured",
      );
    }

    return value.replace(/\/+$/, "");
  }

  private get scopes(): string {
    const value =
      this.config.get<string>("SHOPIFY_SCOPES") ||
      "read_orders,read_products,read_inventory";

    return value
      .split(",")
      .map((scope) => scope.trim())
      .filter(Boolean)
      .join(",");
  }

  validateInstallRequest(
    query: Record<string, unknown>,
  ): string {
    const shop = query.shop;

    if (typeof shop !== "string" || !isValidShopDomain(shop)) {
      throw new BadRequestException(
        "Invalid Shopify shop domain",
      );
    }

    if (!verifyShopifyQueryHmac(query, this.apiSecret)) {
      throw new UnauthorizedException(
        "Invalid Shopify installation signature",
      );
    }

    const timestamp = Number(query.timestamp);

    if (
      !Number.isInteger(timestamp) ||
      Math.abs(Math.floor(Date.now() / 1000) - timestamp) > 300
    ) {
      throw new UnauthorizedException(
        "Expired Shopify installation request",
      );
    }

    return shop.toLowerCase();
  }

  buildAuthorizationUrl(shop: string): string {
    if (!isValidShopDomain(shop)) {
      throw new BadRequestException(
        "Invalid Shopify shop domain",
      );
    }

    const state = createSignedState(
      shop,
      this.config.getOrThrow<string>("JWT_SECRET"),
    );

    const params = new URLSearchParams({
      client_id: this.apiKey,
      scope: this.scopes,
      redirect_uri: `${this.appUrl}/auth/shopify/callback`,
      state,
    });

    return `https://${shop}/admin/oauth/authorize?${params.toString()}`;
  }

  /**
   * Separate, explicit re-consent flow (Phase 8): a store that
   * already completed the read-only install can be sent through this
   * to additionally grant write scopes. Shopify's OAuth requires the
   * full desired scope set on each authorize request (not just the
   * new scopes), so this requests read + write together — the
   * merchant sees exactly what's being added.
   *
   * Deliberately never called from the initial install path: a
   * merchant should only ever see this screen when they take a
   * separate, explicit action to grant it.
   */
  async buildWriteAccessAuthorizationUrl(shop: string): Promise<string> {
    if (!isValidShopDomain(shop)) {
      throw new BadRequestException(
        "Invalid Shopify shop domain",
      );
    }

    // Resolving a store by shop domain, before any tenant context
    // exists, is inherently a cross-tenant lookup.
    const store = await this.prisma.runAsSystem(() =>
      this.prisma.storeConnection.findUnique({
        where: {
          platform_externalStoreId: {
            platform: StorePlatform.SHOPIFY,
            externalStoreId: shop.toLowerCase(),
          },
        },
      }),
    );

    if (!store || store.status !== StoreConnectionStatus.ACTIVE) {
      throw new BadRequestException(
        "This store must complete the read-only install before requesting write access",
      );
    }

    const writeScopes = this.config
      .get<string>("SHOPIFY_WRITE_SCOPES", "write_orders")
      .split(",")
      .map((scope) => scope.trim())
      .filter(Boolean);

    const combinedScopes = Array.from(
      new Set([...this.scopes.split(","), ...writeScopes]),
    ).join(",");

    const state = createSignedState(
      shop,
      this.config.getOrThrow<string>("JWT_SECRET"),
    );

    const params = new URLSearchParams({
      client_id: this.apiKey,
      scope: combinedScopes,
      redirect_uri: `${this.appUrl}/auth/shopify/callback`,
      state,
    });

    return `https://${shop}/admin/oauth/authorize?${params.toString()}`;
  }

  validateCallback(
    query: Record<string, unknown>,
  ): {
    shop: string;
    code: string;
    state: string;
  } {
    const shop = query.shop;
    const code = query.code;
    const state = query.state;

    if (
      typeof shop !== "string" ||
      !isValidShopDomain(shop)
    ) {
      throw new BadRequestException(
        "Invalid Shopify shop domain",
      );
    }

    if (typeof code !== "string" || !code) {
      throw new BadRequestException(
        "Missing Shopify authorization code",
      );
    }

    if (typeof state !== "string" || !state) {
      throw new UnauthorizedException(
        "Missing Shopify OAuth state",
      );
    }

    if (!verifyShopifyQueryHmac(query, this.apiSecret)) {
      throw new UnauthorizedException(
        "Invalid Shopify callback signature",
      );
    }

    const validState = verifySignedState(
      state,
      shop.toLowerCase(),
      this.config.getOrThrow<string>("JWT_SECRET"),
    );

    if (!validState) {
      throw new UnauthorizedException(
        "Invalid or expired Shopify OAuth state",
      );
    }

    return {
      shop: shop.toLowerCase(),
      code,
      state,
    };
  }

  async exchangeCode(
    shop: string,
    code: string,
  ): Promise<{
    accessToken: string;
    scopes: string[];
  }> {
    const body = new URLSearchParams({
      client_id: this.apiKey,
      client_secret: this.apiSecret,
      code,
    });

    const response = await fetch(
      `https://${shop}/admin/oauth/access_token`,
      {
        method: "POST",
        headers: {
          "Content-Type":
            "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body,
      },
    );

    if (!response.ok) {
      throw new UnauthorizedException(
        "Shopify authorization code exchange failed",
      );
    }

    const data =
      (await response.json()) as ShopifyTokenResponse;

    if (
      typeof data.access_token !== "string" ||
      !data.access_token
    ) {
      throw new UnauthorizedException(
        "Shopify did not return an access token",
      );
    }

    const scopes =
      typeof data.scope === "string"
        ? data.scope
            .split(",")
            .map((scope) => scope.trim())
            .filter(Boolean)
        : [];

        console.log("[SHOPIFY DEBUG] GRANTED_SCOPES:", scopes.join(","));
        console.log("[SHOPIFY DEBUG] REQUESTED_SCOPES:", this.scopes);

    const requestedScopes = new Set(
      this.scopes.split(",").map((scope) => scope.trim()),
    );

    const grantedScopes = new Set(scopes);

    for (const required of requestedScopes) {
      if (!grantedScopes.has(required)) {
        throw new UnauthorizedException(
          `Shopify did not grant required scope: ${required}`,
        );
      }
    }

    return {
      accessToken: data.access_token,
      scopes,
    };
  }

  /**
   * Real per-merchant tenant provisioning. Every distinct shop domain
   * gets its own Tenant, created the first time it installs — never a
   * shared dev tenant. A shop reinstalling/reauthenticating reuses
   * its existing tenant rather than creating a duplicate.
   *
   * Returns a freshly-issued API key ONLY when a new tenant was just
   * created — the merchant's one chance to see it before it's hashed
   * away for good. A reinstall of an already-known shop returns
   * apiKey: null; use the key-issuance script/endpoint to mint
   * another one if needed.
   */
  async activateStore(
    shop: string,
    accessToken: string,
    scopes: string[],
  ) {
    // Provisioning a tenant, and resolving/creating a store by shop
    // domain, is the one deliberately-privileged operation in this
    // system — it runs before any tenant context can exist by definition.
    return this.prisma.runAsSystem(async () => {
      const existing = await this.prisma.storeConnection.findUnique({
        where: {
          platform_externalStoreId: {
            platform: StorePlatform.SHOPIFY,
            externalStoreId: shop,
          },
        },
        select: { tenantId: true },
      });

      let tenantId: string;
      let apiKey: string | null = null;

      if (existing) {
        tenantId = existing.tenantId;
      } else {
        const shopName = await this.fetchShopName(shop, accessToken);

        const tenant = await this.prisma.tenant.create({
          data: { name: shopName ?? shop },
        });

        tenantId = tenant.id;

        const issued = await this.tenantApiKeyService.issueKey({
          tenantId,
          label: `${shop} — initial install`,
        });

        apiKey = issued.rawKey;
      }

      const encryptedAccessToken = encryptSecret(
        accessToken,
        this.encryptionKey,
      );

      const store = await this.prisma.storeConnection.upsert({
        where: {
          platform_externalStoreId: {
            platform: StorePlatform.SHOPIFY,
            externalStoreId: shop,
          },
        },
        create: {
          tenantId,
          platform: StorePlatform.SHOPIFY,
          externalStoreId: shop,
          status: StoreConnectionStatus.ACTIVE,
          encryptedAccessToken,
          scopes,
          installedAt: new Date(),
          disconnectedAt: null,
        },
        update: {
          tenantId,
          platform: StorePlatform.SHOPIFY,
          status: StoreConnectionStatus.ACTIVE,
          encryptedAccessToken,
          scopes,
          installedAt: new Date(),
          disconnectedAt: null,
        },
        select: {
          id: true,
          externalStoreId: true,
          status: true,
          scopes: true,
          installedAt: true,
        },
      });

      return { ...store, tenantId, apiKey };
    });
  }

  /**
   * Best-effort only: a nicer tenant name than the raw shop domain.
   * Never blocks or fails installation if it doesn't work.
   */
  private async fetchShopName(
    shop: string,
    accessToken: string,
  ): Promise<string | null> {
    try {
      const response = await fetch(
        `https://${shop}/admin/api/2026-07/graphql.json`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Shopify-Access-Token": accessToken,
          },
          body: JSON.stringify({ query: "{ shop { name } }" }),
        },
      );

      if (!response.ok) {
        return null;
      }

      const result = (await response.json()) as {
        data?: { shop?: { name?: string } };
      };

      return result.data?.shop?.name?.trim() || null;
    } catch {
      return null;
    }
  }
}
