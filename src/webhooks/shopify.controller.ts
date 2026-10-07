import {
  Controller,
  Headers,
  Post,
  RawBodyRequest,
  Req,
  UnauthorizedException,
} from "@nestjs/common";

import { ConfigService } from "@nestjs/config";
import { FastifyRequest } from "fastify";
import { createHash } from "crypto";

import { Prisma } from "@prisma/client";

import { PrismaService } from "../prisma/prisma.service";
import { verifyShopifyWebhook } from "./shopify-signature";

import { WebhookQueueService } from "../queue/webhook.queue";

@Controller("webhooks")
export class ShopifyController {
  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    private readonly webhookQueue: WebhookQueueService,
  ) {}

  @Post("shopify")
  async handleShopifyWebhook(
    @Req() req: RawBodyRequest<FastifyRequest>,
    @Headers("x-shopify-hmac-sha256") signature?: string,
    @Headers("x-shopify-shop-domain") shopDomain?: string,
    @Headers("x-shopify-webhook-id") webhookId?: string,
    @Headers("x-shopify-topic") topic?: string,
  ) {
    const secret = this.configService.get<string>(
      "SHOPIFY_WEBHOOK_SECRET",
     );

    if (!secret) {
      throw new Error(
        "SHOPIFY_WEBHOOK_SECRET is not configured",
      );
    }

    if (!req.rawBody) {
      throw new Error(
        "Raw request body is unavailable",
      );
    }

    const valid = verifyShopifyWebhook(
      req.rawBody,
      signature,
      secret,
    );

    if (!valid) {
      throw new UnauthorizedException(
        "Invalid Shopify webhook signature",
      );
    }

    if (!shopDomain || !webhookId || !topic) {
      throw new Error(
        "Required Shopify webhook headers are missing",
      );
    }

    const rawBody = req.rawBody;

    const payloadSha256 = createHash("sha256")
      .update(rawBody)
      .digest("hex");

    let payload: Prisma.InputJsonValue;

    try {
      payload = JSON.parse(
        rawBody.toString("utf8"),
      );
    } catch {
      throw new Error(
        "Invalid JSON webhook payload",
      );
    }

    // Which tenant this belongs to is exactly what we're resolving
    // here (from shopDomain) — inherently a cross-tenant lookup that
    // must run before any tenant context exists.
    const webhookEventId = await this.prisma.runAsSystem(async () => {
      const store =
        await this.prisma.storeConnection.findUnique({
          where: {
            shopDomain: String(shopDomain),
          },
        });

      if (!store) {
        throw new Error(
          "Shopify store not found: " +
            String(shopDomain),
        );
      }

      const webhookEvent =
        await this.prisma.webhookEvent.upsert({
          where: {
            storeId_shopifyEventId: {
              storeId: store.id,
              shopifyEventId: String(webhookId),
            },
          },

          create: {
            tenantId: store.tenantId,
            storeId: store.id,
            topic: String(topic),
            shopifyEventId: String(webhookId),
            payload,
            payloadSha256,
            status: "RECEIVED",
            attempts: 0,
          },

          update: {},
        });

      return webhookEvent.id;
    });

    await this.webhookQueue.enqueue(webhookEventId);

    return {
      accepted: true,
    };
  }
}
