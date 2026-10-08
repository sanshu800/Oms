import { BadRequestException } from "@nestjs/common";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { ShopifyConnector } from "../connectors/shopify/shopify.connector";
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
    resetForRetry: false,
  };

  const intake = {
    recordDelivery: vi.fn().mockResolvedValue(delivery),
    enqueueForProcessing: vi.fn().mockResolvedValue(undefined),
  } as unknown as WebhookIntakeService;

  const connector = new ShopifyConnector({} as never, {} as never);

  let controller: ShopifyController;

  beforeEach(() => {
    vi.clearAllMocks();
    (intake.recordDelivery as ReturnType<typeof vi.fn>).mockResolvedValue(
      delivery,
    );
    controller = new ShopifyController(intake, connector);
  });

  const call = (overrides: Record<string, unknown> = {}) => {
    const request = {
      rawBody: Buffer.from(JSON.stringify({ id: 1 })),
      ...(overrides.request as object | undefined),
    } as { rawBody?: Buffer };

    const headers: Record<string, string | undefined> = {
      "x-shopify-hmac-sha256": "signature",
      "x-shopify-shop-domain": "techmart-lab.myshopify.com",
      "x-shopify-webhook-id": "wh-1",
      "x-shopify-topic": "orders/create",
    };

    for (const [key, value] of Object.entries(overrides)) {
      if (key === "request") continue;
      const headerName =
        key === "signature"
          ? "x-shopify-hmac-sha256"
          : key === "shopDomain"
            ? "x-shopify-shop-domain"
            : key === "webhookId"
              ? "x-shopify-webhook-id"
              : key === "topic"
                ? "x-shopify-topic"
                : key;
      headers[headerName] = value as string | undefined;
    }

    return controller.handleShopifyWebhook(request as never, headers);
  };

  it("accepts a well-formed delivery and reports the stored event", async () => {
    await expect(call()).resolves.toEqual({
      accepted: true,
      webhookEventId: "event-1",
      duplicate: false,
    });

    expect(intake.recordDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        connector,
        envelope: {
          storeKey: "techmart-lab.myshopify.com",
          externalEventId: "wh-1",
          topic: "orders/create",
        },
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
    expect(intake.recordDelivery).not.toHaveBeenCalled();
  });

  it("reports a duplicate delivery without re-queueing", async () => {
    (intake.recordDelivery as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      webhookEventId: "event-1",
      shouldEnqueue: false,
      resetForRetry: false,
    });

    await expect(call()).resolves.toEqual({
      accepted: true,
      webhookEventId: "event-1",
      duplicate: true,
    });
    expect(intake.enqueueForProcessing).toHaveBeenCalledWith(
      expect.objectContaining({ shouldEnqueue: false }),
    );
  });

  it.each([
    ["shop domain", { shopDomain: undefined }],
    ["webhook id", { webhookId: undefined }],
    ["topic", { topic: undefined }],
  ])("rejects a delivery missing the %s header", async (_label, headers) => {
    await expect(call(headers)).rejects.toBeInstanceOf(BadRequestException);
    expect(intake.recordDelivery).not.toHaveBeenCalled();
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
    expect(intake.recordDelivery).not.toHaveBeenCalled();
  });
});
