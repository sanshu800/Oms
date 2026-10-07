import { Injectable } from "@nestjs/common";
import { AuditActorType } from "@prisma/client";

import { PrismaService } from "../../prisma/prisma.service";
import { ExceptionService } from "../../oms/exception/exception.service";
import { AuditService } from "../../oms/audit/audit.service";
import { InventoryTruthService } from "../../oms/inventory/inventory-truth.service";
import { OrderQueryService } from "../../oms/order/order-query.service";
import { AiMemoryService } from "../memory/ai-memory.service";
import { LlmToolDefinition } from "../llm/llm-client.interface";

export type AiToolContext = {
  tenantId: string;
  storeId: string;
};

/**
 * Phase 5.1: the full read-only tool layer. Every tool here is
 * read-only by construction: the agent investigates, it never
 * mutates operational state directly. Consequential action only
 * ever happens through the structured AiDecisionProposal, after
 * human approval (Phase 5.4) or an earned autonomy policy (Phase 7).
 *
 * Each tool wraps an existing OMS service rather than querying
 * Prisma ad hoc, except where no service exists yet for a pure read
 * (fulfillment/shipment history, past-exception lookup) — those stay
 * scoped to tenantId/storeId exactly like every other query in the
 * codebase.
 */
@Injectable()
export class AiToolsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly exceptionService: ExceptionService,
    private readonly auditService: AuditService,
    private readonly inventoryTruthService: InventoryTruthService,
    private readonly orderQueryService: OrderQueryService,
    private readonly aiMemoryService: AiMemoryService,
  ) {}

  getToolDefinitions(): LlmToolDefinition[] {
    return [
      {
        name: "get_exception_context",
        description:
          "Fetch the full operational context for the exception under investigation: its evidence, category, severity, and the related order (if the evidence references one). Use this first to ground the investigation in actual recorded facts before proposing anything.",
        parameters: {
          type: "object",
          properties: {
            exceptionId: {
              type: "string",
              description: "The operational exception id to look up.",
            },
          },
          required: ["exceptionId"],
        },
      },
      {
        name: "get_inventory_truth",
        description:
          "Get the current canonical inventory position for a SKU: available/reserved/committed quantities per location, and whether the data is stale. Use this whenever the exception concerns inventory levels or a stockout/overselling risk.",
        parameters: {
          type: "object",
          properties: {
            sku: {
              type: "string",
              description: "The canonical merchant SKU to look up.",
            },
          },
          required: ["sku"],
        },
      },
      {
        name: "get_order_detail",
        description:
          "Get full order detail: line items, inventory reservations, and fulfillment/shipment history for one order. Use this when the exception references an order and you need to see its actual line items and fulfillment progress, not just the exception evidence.",
        parameters: {
          type: "object",
          properties: {
            orderId: {
              type: "string",
              description: "The internal order id.",
            },
          },
          required: ["orderId"],
        },
      },
      {
        name: "get_similar_past_exceptions",
        description:
          "Find past operational exceptions of the same category (optionally narrowed to the same SKU) in this store, to check whether this is a recurring pattern versus a one-off. Use this before proposing a confidence level or basis — recurring patterns support TENANT_HISTORY basis, a first-time occurrence does not.",
        parameters: {
          type: "object",
          properties: {
            category: {
              type: "string",
              description: "The exception category to match, e.g. INVENTORY_INTEGRITY, RESERVATION_INTEGRITY.",
            },
            sku: {
              type: "string",
              description: "Optional: narrow results to exceptions whose evidence references this SKU.",
            },
            excludeExceptionId: {
              type: "string",
              description: "Optional: exclude the exception currently under investigation from the results.",
            },
            limit: {
              type: "number",
              description: "Max results to return. Defaults to 10.",
            },
          },
          required: ["category"],
        },
      },
      {
        name: "get_tenant_memory",
        description:
          "Get this tenant's actual track record of human decisions on past AI proposals — how many were approved vs rejected, per category/action-type. This is real learned history, not the model's own past guesses. Use this before choosing TENANT_HISTORY as a basis: only claim it if a memory fact here actually supports it, otherwise use POOLED_PRIOR or HEURISTIC.",
        parameters: {
          type: "object",
          properties: {
            category: {
              type: "string",
              description: "Optional: the exception category to narrow results to, e.g. INVENTORY_INTEGRITY.",
            },
          },
        },
      },
      {
        name: "get_audit_history",
        description:
          "Get the recorded audit trail for a specific entity (an order, an exception, a fulfillment, etc.) — every action taken on it, by whom/what, and when. Use this to understand what has already been tried or decided about this entity before you propose something.",
        parameters: {
          type: "object",
          properties: {
            entityType: {
              type: "string",
              description: "e.g. ORDER, OPERATIONAL_EXCEPTION, WEBHOOK_EVENT.",
            },
            entityId: {
              type: "string",
              description: "The id of the entity.",
            },
          },
          required: ["entityType", "entityId"],
        },
      },
    ];
  }

  async execute(
    context: AiToolContext,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    switch (toolName) {
      case "get_exception_context":
        return this.getExceptionContext(context, args);
      case "get_inventory_truth":
        return this.getInventoryTruth(context, args);
      case "get_order_detail":
        return this.getOrderDetail(context, args);
      case "get_similar_past_exceptions":
        return this.getSimilarPastExceptions(context, args);
      case "get_tenant_memory":
        return this.getTenantMemory(context, args);
      case "get_audit_history":
        return this.getAuditHistory(context, args);
      default:
        return { error: `Unknown tool: ${toolName}` };
    }
  }

  private async getExceptionContext(
    context: AiToolContext,
    args: Record<string, unknown>,
  ) {
    const exceptionId = args.exceptionId;

    if (typeof exceptionId !== "string" || exceptionId.trim() === "") {
      return { error: "exceptionId is required" };
    }

    const exception = await this.exceptionService.getById({
      tenantId: context.tenantId,
      storeId: context.storeId,
      exceptionId,
    });

    if (!exception) {
      return { error: "Operational exception not found in this tenant/store" };
    }

    const evidence =
      exception.evidence && typeof exception.evidence === "object"
        ? (exception.evidence as Record<string, unknown>)
        : {};

    const orderId = typeof evidence.orderId === "string" ? evidence.orderId : null;

    const order = orderId
      ? await this.orderQueryService.getOrderWithDetails({
          tenantId: context.tenantId,
          storeId: context.storeId,
          orderId,
        })
      : null;

    return {
      exception: {
        id: exception.id,
        category: exception.category,
        severity: exception.severity,
        status: exception.status,
        title: exception.title,
        evidence,
        recommendedNextStep: exception.recommendedNextStep,
        detectedAt: exception.detectedAt,
      },
      order,
    };
  }

  private async getInventoryTruth(
    context: AiToolContext,
    args: Record<string, unknown>,
  ) {
    const sku = args.sku;

    if (typeof sku !== "string" || sku.trim() === "") {
      return { error: "sku is required" };
    }

    try {
      const truth = await this.inventoryTruthService.getSkuTruth({
        tenantId: context.tenantId,
        sku,
      });

      if (!truth) {
        return { error: `No canonical inventory item exists for SKU ${sku}` };
      }

      return { inventoryTruth: truth };
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async getOrderDetail(
    context: AiToolContext,
    args: Record<string, unknown>,
  ) {
    const orderId = args.orderId;

    if (typeof orderId !== "string" || orderId.trim() === "") {
      return { error: "orderId is required" };
    }

    const order = await this.orderQueryService.getOrderWithDetails({
      tenantId: context.tenantId,
      storeId: context.storeId,
      orderId,
    });

    if (!order) {
      return { error: "Order not found in this tenant/store" };
    }

    return { order };
  }

  private async getSimilarPastExceptions(
    context: AiToolContext,
    args: Record<string, unknown>,
  ) {
    const category = args.category;

    if (typeof category !== "string" || category.trim() === "") {
      return { error: "category is required" };
    }

    const sku = typeof args.sku === "string" ? args.sku : undefined;
    const excludeExceptionId =
      typeof args.excludeExceptionId === "string"
        ? args.excludeExceptionId
        : undefined;
    const limit =
      typeof args.limit === "number" && args.limit > 0
        ? Math.min(Math.floor(args.limit), 25)
        : 10;

    const exceptions = await this.prisma.operationalException.findMany({
      where: {
        tenantId: context.tenantId,
        storeId: context.storeId,
        category,
        ...(excludeExceptionId ? { id: { not: excludeExceptionId } } : {}),
        ...(sku
          ? {
              evidence: {
                path: ["sku"],
                equals: sku,
              },
            }
          : {}),
      },
      orderBy: { detectedAt: "desc" },
      take: limit,
      select: {
        id: true,
        category: true,
        severity: true,
        status: true,
        title: true,
        evidence: true,
        detectedAt: true,
        resolvedAt: true,
      },
    });

    return {
      count: exceptions.length,
      exceptions,
    };
  }

  private async getTenantMemory(
    context: AiToolContext,
    args: Record<string, unknown>,
  ) {
    const category = typeof args.category === "string" ? args.category : undefined;

    const facts = await this.aiMemoryService.getCurrentFacts({
      tenantId: context.tenantId,
      category,
    });

    return {
      count: facts.length,
      facts: facts.map((f) => ({
        category: f.category,
        fact: f.fact,
        confidence: f.confidence,
        lastConfirmedAt: f.lastConfirmedAt,
      })),
    };
  }

  private async getAuditHistory(
    context: AiToolContext,
    args: Record<string, unknown>,
  ) {
    const entityType = args.entityType;
    const entityId = args.entityId;

    if (typeof entityType !== "string" || entityType.trim() === "") {
      return { error: "entityType is required" };
    }

    if (typeof entityId !== "string" || entityId.trim() === "") {
      return { error: "entityId is required" };
    }

    const history = await this.auditService.getEntityHistory({
      tenantId: context.tenantId,
      storeId: context.storeId,
      entityType,
      entityId,
    });

    return {
      count: history.length,
      events: history.map((event) => ({
        action: event.action,
        actorType: event.actorType satisfies AuditActorType,
        actorId: event.actorId,
        metadata: event.metadata,
        occurredAt: event.occurredAt,
      })),
    };
  }
}
