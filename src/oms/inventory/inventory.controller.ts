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

import { AuthTenant } from "../../auth/auth-tenant.decorator";
import { TenantApiKeyGuard } from "../../auth/tenant-api-key.guard";
import { TenantRlsInterceptor } from "../../auth/tenant-rls.interceptor";
import { InventoryService } from "./inventory.service";

@Controller("oms/inventory")
@UseGuards(TenantApiKeyGuard)
@UseInterceptors(TenantRlsInterceptor)
export class InventoryController {
  constructor(private readonly inventoryService: InventoryService) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  async listItems(
    @AuthTenant() tenantId: string,
    @Query("storeId") storeId: string,
    @Query("q") query?: string,
    @Query("page") page?: string,
    @Query("limit") limit?: string,
  ) {
    return this.inventoryService.listItems({
      tenantId,
      storeId: this.requireQueryValue(storeId, "storeId"),
      query: query?.trim() || undefined,
      page: this.parsePositiveInteger(page, "page", 1),
      limit: this.parsePositiveInteger(limit, "limit", 50),
    });
  }

  @Get(":sku")
  @HttpCode(HttpStatus.OK)
  async getItem(
    @Param("sku") sku: string,
    @AuthTenant() tenantId: string,
    @Query("storeId") storeId: string,
  ) {
    const item = await this.inventoryService.getItem({
      tenantId,
      storeId: this.requireQueryValue(storeId, "storeId"),
      sku: this.requireQueryValue(sku, "sku"),
    });

    if (!item) {
      throw new NotFoundException("Inventory item not found");
    }

    return item;
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

  private requireQueryValue(value: string | undefined, field: string): string {
    if (!value?.trim()) {
      throw new BadRequestException(`${field} is required`);
    }
    return value.trim();
  }
}
