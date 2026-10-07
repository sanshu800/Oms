import { BadRequestException, NotFoundException } from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@prisma/client", () => import("../../../test-utils/prisma-client.mock"));

import { OrderController } from "./order.controller";

describe("OrderController", () => {
  const orderQueryService = {
    listOrders: vi.fn(),
    getOrderWithDetails: vi.fn(),
  };
  let controller: OrderController;

  beforeEach(() => {
    vi.clearAllMocks();
    controller = new OrderController(orderQueryService as any);
  });

  it("lists orders using the authenticated tenant and selected store scope", async () => {
    orderQueryService.listOrders.mockResolvedValue({
      items: [],
      total: 0,
      page: 2,
      limit: 20,
      totalPages: 0,
    });

    await controller.listOrders(
      "tenant-from-auth",
      " store-1 ",
      "new",
      "2",
      "20",
      "2026-08-01T00:00:00.000Z",
      "2026-08-31T23:59:59.999Z",
    );

    expect(orderQueryService.listOrders).toHaveBeenCalledWith({
      tenantId: "tenant-from-auth",
      storeId: "store-1",
      status: "NEW",
      page: 2,
      limit: 20,
      from: new Date("2026-08-01T00:00:00.000Z"),
      to: new Date("2026-08-31T23:59:59.999Z"),
    });
  });

  it("rejects invalid filters before querying orders", async () => {
    await expect(
      controller.listOrders("tenant-1", "store-1", "unknown"),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(orderQueryService.listOrders).not.toHaveBeenCalled();
  });

  it("returns only a detail result scoped to tenant, store, and order", async () => {
    const order = { id: "order-1", items: [], reservations: [] };
    orderQueryService.getOrderWithDetails.mockResolvedValue(order);

    await expect(
      controller.getOrder("order-1", "tenant-1", "store-1"),
    ).resolves.toBe(order);
    expect(orderQueryService.getOrderWithDetails).toHaveBeenCalledWith({
      tenantId: "tenant-1",
      storeId: "store-1",
      orderId: "order-1",
    });
  });

  it("does not reveal orders outside the scoped query", async () => {
    orderQueryService.getOrderWithDetails.mockResolvedValue(null);

    await expect(
      controller.getOrder("missing-order", "tenant-1", "store-1"),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
