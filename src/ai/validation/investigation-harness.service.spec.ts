import { describe, expect, it, vi } from "vitest";

import { OrderBusinessFailureError } from "../../oms/order/order-business-failure.error";
import { InvestigationHarnessService } from "./investigation-harness.service";
import { ScriptedLlmClient } from "./scripted-llm.client";

function buildDeps() {
  const prisma = {
    tenant: { create: vi.fn() },
    storeConnection: { create: vi.fn() },
    inventoryLocation: { create: vi.fn() },
    inventoryItem: { create: vi.fn() },
    inventoryBalance: { create: vi.fn() },
    order: { findFirstOrThrow: vi.fn() },
    runAsTenant: vi.fn((_tenantId: string, fn: () => unknown) => fn()),
  };

  prisma.tenant.create.mockResolvedValue({ id: "tenant-1" });
  prisma.storeConnection.create.mockResolvedValue({ id: "store-1" });
  prisma.inventoryLocation.create.mockResolvedValue({ id: "location-1" });
  prisma.inventoryItem.create.mockResolvedValue({
    id: "item-1",
    sku: "SKU-1",
  });
  prisma.inventoryBalance.create.mockResolvedValue({});
  prisma.order.findFirstOrThrow.mockResolvedValue({ id: "order-blocked" });

  const orderService = {
    upsertFromChannel: vi.fn(),
  };

  const investigationService = {
    investigate: vi.fn().mockResolvedValue({
      investigationId: "investigation-1",
      status: "COMPLETED",
      proposalId: "proposal-1",
    }),
  };

  const evaluationService = {
    evaluate: vi.fn().mockResolvedValue({
      verdict: "PASS",
      criteria: [],
      metrics: {},
      unavailableMetrics: [],
    }),
  };

  const service = new InvestigationHarnessService(
    prisma as never,
    orderService as never,
    investigationService as never,
    evaluationService as never,
  );

  return {
    service,
    prisma,
    orderService,
    investigationService,
    evaluationService,
  };
}

function businessFailure(exceptionId: string) {
  return new OrderBusinessFailureError(
    "reservation failed",
    exceptionId,
    "order-blocked",
  );
}

describe("InvestigationHarnessService", () => {
  it("seeds INVENTORY_SHORTAGE through the real detection path and captures the raised exception", async () => {
    const { service, orderService } = buildDeps();

    orderService.upsertFromChannel.mockRejectedValue(
      businessFailure("exception-1"),
    );

    const seed = await service.seedScenario("INVENTORY_SHORTAGE", "s1");

    expect(seed.scenario).toBe("INVENTORY_SHORTAGE");
    expect(seed.exceptionId).toBe("exception-1");
    expect(seed.heldOrderId).toBeNull();
    expect(seed.blockedOrderId).toBe("order-blocked");
    // Only the blocked order is attempted for this scenario.
    expect(orderService.upsertFromChannel).toHaveBeenCalledTimes(1);
  });

  it("seeds RESERVATION_FAILURE with a held order that owns the stock first", async () => {
    const { service, orderService } = buildDeps();

    orderService.upsertFromChannel
      .mockResolvedValueOnce({ id: "order-held" })
      .mockRejectedValueOnce(businessFailure("exception-2"));

    const seed = await service.seedScenario("RESERVATION_FAILURE", "s2");

    expect(seed.heldOrderId).toBe("order-held");
    expect(seed.exceptionId).toBe("exception-2");
    expect(orderService.upsertFromChannel).toHaveBeenCalledTimes(2);
  });

  it("fails loudly when a scenario seed does not produce an exception", async () => {
    const { service, orderService } = buildDeps();

    orderService.upsertFromChannel.mockResolvedValue({ id: "order-ok" });

    await expect(service.seedScenario("INVENTORY_SHORTAGE", "s3")).rejects.toThrow(
      /did not produce an operational exception/i,
    );
  });

  it("runAgainstException calls the existing investigate port and evaluates the persisted run", async () => {
    const { service, investigationService, evaluationService } = buildDeps();
    const prepare = vi.fn();

    const report = await service.runAgainstException({
      tenantId: "tenant-1",
      storeId: "store-1",
      exceptionId: "exception-1",
      scenario: "INVENTORY_SHORTAGE",
      prepare,
    });

    expect(prepare).toHaveBeenCalledTimes(1);
    expect(investigationService.investigate).toHaveBeenCalledWith({
      tenantId: "tenant-1",
      storeId: "store-1",
      exceptionId: "exception-1",
    });
    expect(evaluationService.evaluate).toHaveBeenCalledWith(
      expect.objectContaining({
        scenario: "INVENTORY_SHORTAGE",
        investigationId: "investigation-1",
      }),
    );
    expect(report.evaluation.verdict).toBe("PASS");
  });

  it("the scripted double is swappable through the same LLM_CLIENT contract a real provider would use", async () => {
    const double = new ScriptedLlmClient();

    double.setScript([
      {
        toolCalls: [
          { name: "get_exception_context", arguments: { exceptionId: "e1" } },
        ],
      },
    ]);

    const completion = await double.createChatCompletion({
      messages: [],
      tools: [],
    });

    expect(completion.message.toolCalls?.[0]?.name).toBe(
      "get_exception_context",
    );
    expect(completion.tokensUsed).toBe(10);

    double.setThrowOnce("simulated provider outage");

    await expect(
      double.createChatCompletion({ messages: [], tools: [] }),
    ).rejects.toThrow(/provider outage/);
  });
});
