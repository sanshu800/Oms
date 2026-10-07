import {
  BadRequestException,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Query,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { OrderStatus } from "@prisma/client";

import { AuthTenant } from "../../auth/auth-tenant.decorator";
import { TenantApiKeyGuard } from "../../auth/tenant-api-key.guard";
import { TenantRlsInterceptor } from "../../auth/tenant-rls.interceptor";
import { OrderQueryService } from "./order-query.service";

@Controller("oms/orders")
@UseGuards(TenantApiKeyGuard)
@UseInterceptors(TenantRlsInterceptor)
export class OrderController {
  constructor(private readonly orderQueryService: OrderQueryService) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  async listOrders(
    @AuthTenant() tenantId: string,
    @Query("storeId") storeId: string,
    @Query("status") status?: string,
    @Query("page") page?: string,
    @Query("limit") limit?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
  ) {
    const normalizedStoreId = this.requireQueryValue(storeId, "storeId");
    const normalizedStatus = this.parseStatus(status);
    const fromDate = this.parseDate(from, "from");
    const toDate = this.parseDate(to, "to");

    if (fromDate && toDate && fromDate > toDate) {
      throw new BadRequestException("from must be earlier than or equal to to");
    }

    return this.orderQueryService.listOrders({
      tenantId,
      storeId: normalizedStoreId,
      status: normalizedStatus,
      page: this.parsePositiveInteger(page, "page", 1),
      limit: this.parsePositiveInteger(limit, "limit", 50),
      from: fromDate,
      to: toDate,
    });
  }

  @Get(":orderId")
  @HttpCode(HttpStatus.OK)
  async getOrder(
    @Param("orderId") orderId: string,
    @AuthTenant() tenantId: string,
    @Query("storeId") storeId: string,
  ) {
    const normalizedOrderId = this.requireQueryValue(orderId, "orderId");
    const normalizedStoreId = this.requireQueryValue(storeId, "storeId");
    const order = await this.orderQueryService.getOrderWithDetails({
      tenantId,
      storeId: normalizedStoreId,
      orderId: normalizedOrderId,
    });

    if (!order) {
      throw new NotFoundException("Order not found");
    }

    return order;
  }

  private parseStatus(value?: string): OrderStatus | undefined {
    if (!value?.trim()) return undefined;

    const status = value.trim().toUpperCase();
    const supportedStatuses = Object.values(OrderStatus) as string[];
    if (!supportedStatuses.includes(status)) {
      throw new BadRequestException(
        `status must be one of: ${supportedStatuses.join(", ")}`,
      );
    }

    return status as OrderStatus;
  }

  private parsePositiveInteger(
    value: string | undefined,
    field: string,
    fallback: number,
  ): number {
    if (value === undefined) return fallback;
    if (!/^\d+$/.test(value.trim())) {
      throw new BadRequestException(`${field} must be a positive integer`);
    }

    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 1) {
      throw new BadRequestException(`${field} must be a positive integer`);
    }

    return parsed;
  }

  private parseDate(value: string | undefined, field: string): Date | undefined {
    if (value === undefined || value.trim() === "") return undefined;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      throw new BadRequestException(`${field} must be a valid date`);
    }
    return date;
  }

  private requireQueryValue(value: string | undefined, field: string): string {
    if (!value?.trim()) {
      throw new BadRequestException(`${field} is required`);
    }
    return value.trim();
  }
}
