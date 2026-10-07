import {
  BadRequestException,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  Post,
  RawBodyRequest,
  Req,
} from "@nestjs/common";

import { FastifyRequest } from "fastify";
import { createHash } from "crypto";

import { Prisma } from "@prisma/client";

import { WebhookIntakeService } from "./webhook-intake.service";

@Controller("webhooks")
export class ShopifyController {
  constructor(private readonly intake: WebhookIntakeService) {}

  /**
   * Answer a browser or uptime probe that opens the webhook URI by hand.
   *
   * Shopify only ever POSTs here, so without this the honest answer is a
   * generic 404 — which is indistinguishable from "the tunnel is not routing
   * to this app at all" (a misconfigured Cloudflare tunnel answers the same
   * path with its own plain-text `404 page not found`). Returning a distinct
   * JSON body for a GET makes that difference one `curl` away.
   */
  @Get("shopify")
  @HttpCode(405)
  @Header("Allow", "POST")
  describeWebhookEndpoint() {
    return {
      message:
        "Shopify delivers webhooks to this URL with POST. A browser GET is not a delivery.",
      expectedMethod: "POST",
    };
  }

  @Post("shopify")
  @HttpCode(202)
  async handleShopifyWebhook(
    @Req() req: RawBodyRequest<FastifyRequest>,
    @Headers("x-shopify-hmac-sha256") signature?: string,
    @Headers("x-shopify-shop-domain") shopDomain?: string,
    @Headers("x-shopify-webhook-id") webhookId?: string,
    @Headers("x-shopify-topic") topic?: string,
  ) {
    // Malformed deliveries are a client error, not an outage: a 400 keeps
    // monitoring honest and stops Shopify from treating garbage as retryable.
    if (!req.rawBody) {
      throw new BadRequestException("Raw request body is unavailable");
    }

    if (!shopDomain || !webhookId || !topic) {
      throw new BadRequestException(
        "Required Shopify webhook headers are missing",
      );
    }

    const rawBody = req.rawBody;

    const payloadSha256 = createHash("sha256").update(rawBody).digest("hex");

    let payload: Prisma.InputJsonValue;

    try {
      payload = JSON.parse(rawBody.toString("utf8"));
    } catch {
      throw new BadRequestException("Invalid JSON webhook payload");
    }

    // Authenticate, store (durable), then queue under a deadline. The
    // signature is checked inside the intake because the signing secret is
    // per store: a custom app has its own secret, and a store without one
    // falls back to the deployment-wide SHOPIFY_WEBHOOK_SECRET. A queue
    // failure raises 503 so Shopify retries with backoff instead of dropping
    // the event — repeat failures are what get a subscription deleted.
    const delivery = await this.intake.recordShopifyDelivery({
      shopDomain: String(shopDomain),
      webhookId: String(webhookId),
      topic: String(topic),
      payload,
      payloadSha256,
      rawBody,
      signature,
    });

    await this.intake.enqueueForProcessing(delivery);

    return {
      accepted: true,
      webhookEventId: delivery.webhookEventId,
      duplicate: !delivery.shouldEnqueue,
    };
  }
}
