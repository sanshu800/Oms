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
import { WmsProvider } from "@prisma/client";
import { createHash } from "crypto";
import { FastifyRequest } from "fastify";
import { Prisma } from "@prisma/client";

import { AuthTenant } from "../auth/auth-tenant.decorator";
import { TenantApiKeyGuard } from "../auth/tenant-api-key.guard";
import { TenantRlsInterceptor } from "../auth/tenant-rls.interceptor";

import {
  ReadWmsInboundHeaders,
  WMS_ADAPTERS,
  WmsAdapter,
  wmsAdapterForProvider,
} from "./wms-contract";
import { WmsConnectionService } from "./wms-connection.service";
import { WmsEventIntakeService } from "./wms-event-intake.service";
import { WmsRequestService } from "./wms-request.service";

/**
 * The WMS integration's HTTP surface, in two strictly separate halves:
 *
 * - `POST /wms/events` — public, authenticated by the per-connection
 *   signature (like channel webhooks). The warehouse calls US.
 * - `/oms/wms/*` — tenant API-key endpoints for connection configuration
 *   and outbound fulfillment requests. WE call the warehouse.
 *
 * Secret material is write-only on the public API surface: connection
 * responses carry `hasApiKey` / `hasWebhookSecret` booleans, never the
 * credentials themselves.
 */
@Controller()
export class WmsController {
  constructor(
    private readonly intake: WmsEventIntakeService,
    private readonly connectionService: WmsConnectionService,
    private readonly requestService: WmsRequestService,
    @Inject(WMS_ADAPTERS)
    private readonly adapters: readonly WmsAdapter[],
  ) {}

  // ============================================================
  // Inbound: WMS → TechMart (public, signature-authenticated)
  // ============================================================

  @Post("wms/events")
  @HttpCode(HttpStatus.ACCEPTED)
  async handleWmsEvent(
    @Req() req: RawBodyRequest<FastifyRequest>,
    @Headers() headers: ReadWmsInboundHeaders,
  ) {
    if (!req.rawBody) {
      throw new BadRequestException("Raw request body is unavailable");
    }

    const providerRaw = getHeader(headers, "x-wms-provider");

    if (!providerRaw) {
      throw new BadRequestException("Required WMS webhook headers are missing");
    }

    const provider = parseProvider(providerRaw);

    const adapter = wmsAdapterForProvider(this.adapters, provider);

    // Identity first: a delivery missing its headers must get the header
    // error even if its body is also broken.
    const envelope = adapter.readInboundEnvelope(headers);

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
      wmsEventId: recorded.wmsEventId,
    };
  }

  // ============================================================
  // Outbound configuration: tenant-scoped (API-key authenticated)
  // ============================================================

  @Post("oms/wms/connections")
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(TenantApiKeyGuard)
  @UseInterceptors(TenantRlsInterceptor)
  async createConnection(
    @AuthTenant() tenantId: string,
    @Body()
    body: {
      provider?: string;
      externalWarehouseId?: string;
      locationId?: string;
      apiKey?: string;
      webhookSecret?: string;
    },
  ) {
    const provider = parseProvider(body.provider);

    if (!body.externalWarehouseId?.trim()) {
      throw new UnprocessableEntityException("externalWarehouseId is required");
    }

    if (!body.locationId?.trim()) {
      throw new UnprocessableEntityException("locationId is required");
    }

    return this.connectionService.createConnection({
      tenantId,
      provider,
      externalWarehouseId: body.externalWarehouseId,
      locationId: body.locationId,
      apiKey: body.apiKey,
      webhookSecret: body.webhookSecret,
    });
  }

  @Get("oms/wms/connections")
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantApiKeyGuard)
  @UseInterceptors(TenantRlsInterceptor)
  async listConnections(@AuthTenant() tenantId: string) {
    return this.connectionService.listConnections(tenantId);
  }

  @Post("oms/wms/fulfillment-requests")
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(TenantApiKeyGuard)
  @UseInterceptors(TenantRlsInterceptor)
  async submitFulfillmentRequest(
    @AuthTenant() tenantId: string,
    @Body() body: { storeId?: string; fulfillmentId?: string },
  ) {
    if (!body.storeId?.trim()) {
      throw new UnprocessableEntityException("storeId is required");
    }

    if (!body.fulfillmentId?.trim()) {
      throw new UnprocessableEntityException("fulfillmentId is required");
    }

    return this.requestService.submitFulfillmentRequest({
      tenantId,
      storeId: body.storeId,
      fulfillmentId: body.fulfillmentId,
    });
  }
}

function parseProvider(value: string | undefined): WmsProvider {
  if (!value) {
    throw new BadRequestException("WMS provider is required");
  }

  const normalized = value.trim().toUpperCase();
  const provider = (Object.values(WmsProvider) as string[]).find(
    (candidate) => candidate === normalized,
  );

  if (!provider) {
    throw new BadRequestException(`Unsupported WMS provider: ${value}`);
  }

  return provider as WmsProvider;
}

function getHeader(
  headers: ReadWmsInboundHeaders,
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
