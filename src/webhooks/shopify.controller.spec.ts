import { BadRequestException } from "@nestjs/common";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { ShopifyController } from "./shopify.controller";
import { WebhookIntakeService } from "./webhook-intake.service";

/**
 * The controller is the public edge of the intake path: everything Shopify
 * posts arrives here first, so its rejections must be explicit client errors
 * (400) rather than accidental 500s — a 500 on a malformed body would look
 * like an outage to monitoring and to Shopify's retry logic.
 */
describe("ShopifyController", () => {
  const delivery = {
    webhookEventId: "event-1",
    shouldEnqueue: true,
  };

  const intake = {
    recordShopifyDelivery: vi.fn().mockResolvedValue(delivery),
    enqueueForProcessing: vi.fn().mockResolvedValue(undefined),
  } as unknown as WebhookIntakeService;

  let controller: ShopifyController;

  beforeEach(() => {
    vi.clearAllMocks();
    controller = new ShopifyController(intake);
  });

  const call = (overrides: Record<string, unknown> = {}) => {
    const headers = {
      signature: "signature",
      shopDomain: "techmart-lab.myshopify.com",
      webhookId: "wh-1",
      topic: "orders/create",
      request: { rawBody: Buffer.from(JSON.stringify({ id: 1 })) },
      ...overrides,
    } as {
      signature?: string;
      shopDomain?: string;
      webhookId?: string;
      topic?: string;
      request: { rawBody?: Buffer };
    };

    return controller.handleShopifyWebhook(
      headers.request as never,
      headers.signature,
      headers.shopDomain,
      headers.webhookId,
      headers.topic,
    );
  };

  it("accepts a well-formed delivery and reports the stored event", async () => {
    await expect(call()).resolves.toEqual({
      accepted: true,
      webhookEventId: "event-1",
      duplicate: false,
    });

    expect(intake.recordShopifyDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        shopDomain: "techmart-lab.myshopify.com",
        webhookId: "wh-1",
        topic: "orders/create",
        signature: "signature",
        payload: { id: 1 },
      }),
    );
    expect(intake.enqueueForProcessing).toHaveBeenCalledWith(delivery);
  });

  it("describes the endpoint for a browser GET instead of a bare 404", () => {
    // Ops checks and tunnel debugging both start by opening this URL by hand.
    // The answer must be identifiably ours: a misrouted tunnel returns its own
    // plain-text 404, which is otherwise indistinguishable from this endpoint.
    expect(controller.describeWebhookEndpoint()).toEqual({
      message:
        "Shopify delivers webhooks to this URL with POST. A browser GET is not a delivery.",
      expectedMethod: "POST",
    });
    expect(intake.recordShopifyDelivery).not.toHaveBeenCalled();
  });

  it("reports a duplicate delivery without re-queueing", async () => {
    (intake.recordShopifyDelivery as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      webhookEventId: "event-1",
      shouldEnqueue: false,
    });

    await expect(call()).resolves.toEqual({
      accepted: true,
      webhookEventId: "event-1",
      duplicate: true,
    });
  });

  it.each([
    ["shop domain", { shopDomain: undefined }],
    ["webhook id", { webhookId: undefined }],
    ["topic", { topic: undefined }],
  ])("rejects a delivery missing the %s header", async (_label, headers) => {
    await expect(call(headers)).rejects.toBeInstanceOf(BadRequestException);
    expect(intake.recordShopifyDelivery).not.toHaveBeenCalled();
  });

  it("rejects a request whose raw body was not captured", async () => {
    await expect(
      call({ request: { rawBody: undefined } }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("rejects a body that is not valid JSON", async () => {
    await expect(
      call({ request: { rawBody: Buffer.from("not json") } }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
