import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  RawBodyRequest,
  Req,
  UnprocessableEntityException,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { Headers } from "@nestjs/common";
import { ShippingProvider } from "@prisma/client";
import { createHash } from "crypto";
import { FastifyRequest } from "fastify";
import { Prisma } from "@prisma/client";

import { AuthTenant } from "../auth/auth-tenant.decorator";
import { TenantApiKeyGuard } from "../auth/tenant-api-key.guard";
import { TenantRlsInterceptor } from "../auth/tenant-rls.interceptor";

import {
  ReadShippingInboundHeaders,
  SHIPPING_ADAPTERS,
  ShippingProviderAdapter,
  shippingAdapterForProvider,
} from "./shipping-contract";
import { ShippingConnectionService } from "./shipping-connection.service";
import { ShippingEventIntakeService } from "./shipping-event-intake.service";
import { ShippingRequestService } from "./shipping-request.service";

/**
 * The shipping integration's HTTP surface, in two strictly separate halves:
 *
 * - `POST /shipping/events` — public, authenticated by the per-connection
 *   signature (like channel webhooks and WMS events). The provider calls US.
 * - `/oms/shipping/*` — tenant API-key endpoints for connection
 *   configuration and outbound provider requests. WE call the provider.
 *
 * Secret material is write-only on the public API surface: connection
 * responses carry `hasApiKey` / `hasWebhookSecret` booleans, never the
 * credentials themselves.
 */
@Controller()
export class ShippingController {
  constructor(
    private readonly intake: ShippingEventIntakeService,
    private readonly connectionService: ShippingConnectionService,
    private readonly requestService: ShippingRequestService,
    @Inject(SHIPPING_ADAPTERS)
    private readonly adapters: readonly ShippingProviderAdapter[],
  ) {}

  // ============================================================
  // Inbound: shipping provider → TechMart (public, signature-authenticated)
  // ============================================================

  @Post("shipping/events")
  @HttpCode(HttpStatus.ACCEPTED)
  async handleShippingEvent(
    @Req() req: RawBodyRequest<FastifyRequest>,
    @Headers() headers: ReadShippingInboundHeaders,
  ) {
    if (!req.rawBody) {
      throw new BadRequestException("Raw request body is unavailable");
    }

    const providerRaw = getHeader(headers, "x-shipping-provider");

    if (!providerRaw) {
      throw new BadRequestException(
        "Required shipping webhook headers are missing",
      );
    }

    const provider = parseProvider(providerRaw);

    const adapter = shippingAdapterForProvider(this.adapters, provider);

    // Identity first: a delivery missing its headers must get the header
    // error even if its body is also broken.
    const envelope = adapter.readInboundEnvelope({
      headers,
      rawBody: req.rawBody,
    });

    const rawBody = req.rawBody;

    const payloadSha256 = createHash("sha256").update(rawBody).digest("hex");

    let payload: Prisma.InputJsonValue;

    try {
      payload = JSON.parse(rawBody.toString("utf8"));
    } catch {
      throw new BadRequestException("Invalid JSON webhook payload");
    }

    // Authenticate, store (durable), then queue under a deadline.
    const recorded = await this.intake.recordAndQueue({
      adapter,
      envelope,
      headers,
      payload,
      payloadSha256,
      rawBody,
    });

    return {
      status: "accepted",
      shippingEventId: recorded.shippingEventId,
    };
  }

  // ============================================================
  // Outbound configuration: tenant-scoped (API-key authenticated)
  // ============================================================

  @Post("oms/shipping/connections")
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(TenantApiKeyGuard)
  @UseInterceptors(TenantRlsInterceptor)
  async createConnection(
    @AuthTenant() tenantId: string,
    @Body()
    body: {
      provider?: string;
      externalAccountId?: string;
      apiKey?: string;
      webhookSecret?: string;
    },
  ) {
    const provider = parseProvider(body.provider);

    if (!body.externalAccountId?.trim()) {
      throw new UnprocessableEntityException("externalAccountId is required");
    }

    return this.connectionService.createConnection({
      tenantId,
      provider,
      externalAccountId: body.externalAccountId,
      apiKey: body.apiKey,
      webhookSecret: body.webhookSecret,
    });
  }

  @Get("oms/shipping/connections")
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantApiKeyGuard)
  @UseInterceptors(TenantRlsInterceptor)
  async listConnections(@AuthTenant() tenantId: string) {
    return this.connectionService.listConnections(tenantId);
  }

  @Post("oms/shipping/shipment-requests")
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(TenantApiKeyGuard)
  @UseInterceptors(TenantRlsInterceptor)
  async createShipmentRequest(
    @AuthTenant() tenantId: string,
    @Body() body: { storeId?: string; fulfillmentId?: string; provider?: string },
  ) {
    if (!body.storeId?.trim()) {
      throw new UnprocessableEntityException("storeId is required");
    }

    if (!body.fulfillmentId?.trim()) {
      throw new UnprocessableEntityException("fulfillmentId is required");
    }

    return this.requestService.createShipmentForFulfillment({
      tenantId,
      storeId: body.storeId,
      fulfillmentId: body.fulfillmentId,
      provider: body.provider ? parseProvider(body.provider) : undefined,
    });
  }

  @Post("oms/shipping/cancellation-requests")
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(TenantApiKeyGuard)
  @UseInterceptors(TenantRlsInterceptor)
  async createCancellationRequest(
    @AuthTenant() tenantId: string,
    @Body() body: { storeId?: string; shipmentId?: string; reason?: string },
  ) {
    if (!body.storeId?.trim()) {
      throw new UnprocessableEntityException("storeId is required");
    }

    if (!body.shipmentId?.trim()) {
      throw new UnprocessableEntityException("shipmentId is required");
    }

    return this.requestService.requestCancellation({
      tenantId,
      storeId: body.storeId,
      shipmentId: body.shipmentId,
      reason: body.reason,
    });
  }
}

function parseProvider(value: string | undefined): ShippingProvider {
  if (!value) {
    throw new BadRequestException("Shipping provider is required");
  }

  const normalized = value.trim().toUpperCase();
  const provider = (Object.values(ShippingProvider) as string[]).find(
    (candidate) => candidate === normalized,
  );

  if (!provider) {
    throw new BadRequestException(`Unsupported shipping provider: ${value}`);
  }

  return provider as ShippingProvider;
}

function getHeader(
  headers: ReadShippingInboundHeaders,
  name: string,
): string | undefined {
  const lower = name.toLowerCase();

  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) {
      return Array.isArray(value) ? value[0] : value;
    }
  }

  return undefined;
}
