import {
  BadRequestException,
  Controller,
  Get,
  Query,
  Res,
} from "@nestjs/common";
import { FastifyReply } from "fastify";

import { ShopifyAuthService } from "./shopify-auth.service";

@Controller()
export class ShopifyAuthController {
  constructor(
    private readonly auth: ShopifyAuthService,
  ) {}

  @Get()
  async install(
    @Query() query: Record<string, unknown>,
    @Res() reply: FastifyReply,
  ) {
    console.log("[SHOPIFY AUTH] INSTALL keys=", Object.keys(query).sort().join(","), "shop=", String(query.shop ?? ""));
    const shop = this.auth.validateInstallRequest(query);

    const authorizationUrl =
      this.auth.buildAuthorizationUrl(shop);

    reply.code(302).header("Location", authorizationUrl).send();
  }

  /**
   * Phase 8: a separate, explicit request for write access, distinct
   * from the initial read-only install. This is NOT a Shopify-issued
   * launch link (no HMAC to verify) — it's us redirecting an already
   * -installed merchant to grant more. Gated on the store already
   * being an active, installed connection (checked inside the
   * service), which is the only guard available until a real
   * merchant-facing auth/session layer exists (a pre-existing gap
   * this endpoint does not attempt to solve).
   */
  @Get("auth/shopify/request-write-access")
  async requestWriteAccess(
    @Query("shop") shop: string,
    @Res() reply: FastifyReply,
  ) {
    if (!shop?.trim()) {
      throw new BadRequestException("shop is required");
    }

    const authorizationUrl =
      await this.auth.buildWriteAccessAuthorizationUrl(shop.trim());

    reply.code(302).header("Location", authorizationUrl).send();
  }

  @Get("auth/shopify/callback")
  async callback(
    @Query() query: Record<string, unknown>,
    @Res() reply: FastifyReply,
  ) {
    console.log("[SHOPIFY AUTH] CALLBACK keys=", Object.keys(query).sort().join(","), "shop=", String(query.shop ?? ""));
    const { shop, code } = this.auth.validateCallback(query);

    const token =
      await this.auth.exchangeCode(shop, code);

    const store =
      await this.auth.activateStore(
        shop,
        token.accessToken,
        token.scopes,
      );

    const apiKeySection = store.apiKey
      ? `
          <h2>Your API key</h2>
          <p><strong>Save this now — it will never be shown again:</strong></p>
          <pre style="background:#111;color:#0f0;padding:12px;border-radius:6px;overflow-x:auto;">${store.apiKey}</pre>
          <p>Use it as <code>Authorization: Bearer ${store.apiKey}</code> on every TechMart API request for this store.</p>
        `
      : `<p>This store was already connected — no new API key was issued. Use your existing key, or issue a new one via the key-management script.</p>`;

    return reply.type("text/html").send(`
      <!doctype html>
      <html>
        <head>
          <meta charset="utf-8" />
          <title>TechMart Connected</title>
        </head>
        <body>
          <h1>TechMart connected</h1>
          <p>Shopify store: ${store.externalStoreId}</p>
          <p>Status: ${store.status}</p>
          <p>Read-only connection established successfully.</p>
          ${apiKeySection}
        </body>
      </html>
    `);
  }
}





