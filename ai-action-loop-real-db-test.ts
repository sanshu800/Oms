/**
 * Exception-to-Action Loop — real-database acceptance test (product
 * thesis demonstration).
 *
 * ONE continuous, audited loop against real PostgreSQL:
 *
 *   detect (real intake path: a new order's reservation fails because
 *     another order holds the stock → order FAILED + OperationalException
 *     raised automatically; the held order's ACTIVE reservation is the
 *     real operational state)
 *   → investigate (real AiInvestigationService tool loop over real
 *     context via the LLM_CLIENT port with a deterministic scripted
 *     double; AiInvestigation + AiToolCall rows persisted)
 *   → propose (zod-validated AiDecisionProposal, never free text)
 *   → authorize (explicit HUMAN approval; RELEASE_ORDER_RESERVATION is
 *     human-only by hard rail; cross-tenant access denied by RLS)
 *   → revalidate + execute (pre-execution state revalidation; then
 *     RELEASE_ORDER_RESERVATION via InventoryService and ADD_ORDER_NOTE
 *     via the REAL ShopifyActionAdapter)
 *   → verify exact effects (reservation ledger: every row RELEASED with
 *     a matching RELEASE movement of the same reservation id/quantity and
 *     exact balance deltas; external note independently re-read).
 *
 * SIMULATED vs VERIFIED EXTERNAL BEHAVIOR — read this carefully:
 *   - The Shopify GraphQL Admin API is SIMULATED at the HTTP boundary
 *     only (globalThis.fetch for /admin/api/... URLs). The
 *     ShopifyActionAdapter itself is REAL code: scope checks, token
 *     decryption, GraphQL request construction, response handling, and
 *     the independent verify() re-read all execute for real.
 *   - Nothing here has been verified against Shopify's actual servers.
 *     That requires a real dev store + write_orders scope and remains
 *     UNVERIFIED EXTERNAL BEHAVIOR (reported as such).
 *   - Everything on the TechMart side (detection, investigation,
 *     proposals, approval, RLS, audits, inventory effects) runs against
 *     real PostgreSQL and is verified by this script.
 *
 * Failure boundaries exercised below (safeguard 6): investigation,
 * proposal creation, approval, execution, verification.
 *
 * Run topology: same as the other real-DB scripts — non-superuser
 * table-owning role (docs/SHIPPING-PROVIDER.md §8). The flow runs under
 * service-level runAsTenant contexts exactly like production
 * (TenantRlsInterceptor), so RLS is exercised for real.
 *
 * Run: npx ts-node ai-action-loop-real-db-test.ts
 */
import { Test } from "@nestjs/testing";
import { AuditActorType, OrderStatus } from "@prisma/client";

import { AppModule } from "./src/app.module";
import { PrismaService } from "./src/prisma/prisma.service";
import { tenantContextStorage } from "./src/prisma/tenant-context";
import { encryptSecret } from "./src/shopify/shopify-auth.crypto";
import { OrderService } from "./src/oms/order/order.service";
import { OrderBusinessFailureError } from "./src/oms/order/order-business-failure.error";
import { InventoryService } from "./src/oms/inventory/inventory.service";
import { AiInvestigationService } from "./src/ai/investigation/ai-investigation.service";
import { AiDecisionService } from "./src/ai/decision/ai-decision.service";
import {
  LLM_CLIENT,
  LlmChatCompletionInput,
  LlmChatCompletionResult,
  LlmClient,
} from "./src/ai/llm/llm-client.interface";
import type { NormalizedOrder } from "./src/connectors/connector.interface";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`TEST FAILED: ${message}`);
  }
}

// ============================================================
// Deterministic LLM double (existing LLM_CLIENT port — no API keys,
// no new infrastructure). Each `setScript` is one investigation's
// planned turns; every tool call it names is executed for REAL by
// AiInvestigationService against real data.
// ============================================================

type ScriptedTurn = {
  content?: string;
  toolCalls: Array<{ name: string; arguments: Record<string, unknown> }>;
};

class ScriptedLlm implements LlmClient {
  private queue: ScriptedTurn[] = [];
  calls = 0;

  setScript(turns: ScriptedTurn[]) {
    this.queue = [...turns];
    this.calls = 0;
  }

  setThrowOnce(message: string) {
    this.queue = [];
    this.throwMessage = message;
  }

  private throwMessage: string | null = null;

  async createChatCompletion(
    _input: LlmChatCompletionInput,
  ): Promise<LlmChatCompletionResult> {
    if (this.throwMessage) {
      const message = this.throwMessage;
      this.throwMessage = null;
      throw new Error(message);
    }

    this.calls += 1;
    const turn = this.queue.shift();

    if (!turn) {
      throw new Error("ScriptedLlm: no scripted turn left");
    }

    return {
      message: {
        role: "assistant",
        content: turn.content ?? null,
        toolCalls: turn.toolCalls.map((call, index) => ({
          id: `call-${this.calls}-${index}`,
          name: call.name,
          arguments: call.arguments,
        })),
      },
      tokensUsed: 10,
    };
  }
}

// ============================================================
// SIMULATED Shopify GraphQL boundary: the HTTP responses are faked;
// the adapter code that issues and checks them is real.
// ============================================================

type FetchLogEntry = {
  op: "orderUpdate" | "orderRead";
  gid: string;
  note: string | null;
};

function installShopifyHttpSimulator() {
  const notes = new Map<string, string>();
  const log: FetchLogEntry[] = [];
  let verifyMismatchFor: string | null = null;
  const realFetch = globalThis.fetch.bind(globalThis);

  const json = (payload: unknown) =>
    ({
      ok: true,
      status: 200,
      json: async () => payload,
    }) as Response;

  globalThis.fetch = (async (input: unknown, init?: unknown) => {
    const href = String(
      typeof input === "object" && input !== null && "url" in input
        ? (input as { url: string }).url
        : input,
    );

    if (!href.includes("/admin/api/")) {
      return realFetch(input as never, init as never);
    }

    const body = JSON.parse(
      String((init as { body?: string } | undefined)?.body ?? "{}"),
    ) as {
      query?: string;
      variables?: Record<string, unknown>;
    };

    const query = body.query ?? "";

    if (query.includes("orderUpdate")) {
      const inputObj = body.variables?.input as
        | { id?: string; note?: string }
        | undefined;
      const gid = String(inputObj?.id ?? "");
      const note = String(inputObj?.note ?? "");

      notes.set(gid, note);
      log.push({ op: "orderUpdate", gid, note });

      return json({
        data: { orderUpdate: { order: { id: gid, note }, userErrors: [] } },
      });
    }

    if (query.includes("order(")) {
      const gid = String(body.variables?.id ?? "");
      // The independent verification re-read: return what Shopify
      // "actually" holds — or, for the mismatch scenario, a wrong note.
      const stored = notes.get(gid) ?? null;
      const note =
        verifyMismatchFor && stored === verifyMismatchFor
          ? "SIMULATED-MISMATCH-NOTE"
          : stored;

      log.push({ op: "orderRead", gid, note });

      return json({ data: { order: { id: gid, note } } });
    }

    return json({ errors: [{ message: `Unhandled simulated query: ${query}` }] });
  }) as typeof fetch;

  return {
    notes,
    log,
    /** Make the NEXT verify re-read disagree with the written note. */
    armVerifyMismatch(note: string) {
      verifyMismatchFor = note;
    },
    disarmVerifyMismatch() {
      verifyMismatchFor = null;
    },
    restore() {
      globalThis.fetch = realFetch;
    },
  };
}

// ============================================================

async function main() {
  const stamp = Date.now().toString(36);

  const scriptedLlm = new ScriptedLlm();
  const simulator = installShopifyHttpSimulator();

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  })
    .overrideProvider(LLM_CLIENT)
    .useValue(scriptedLlm)
    .compile();

  const app = moduleRef;

  const prisma = app.get(PrismaService, { strict: false });
  const orderService = app.get(OrderService, { strict: false });
  const inventoryService = app.get(InventoryService, { strict: false });
  const investigationService = app.get(AiInvestigationService, {
    strict: false,
  });
  const decisionService = app.get(AiDecisionService, { strict: false });

  try {
    const [pgVersionRows] = await prisma.$queryRaw<
      Array<{ version: string }>
    >`SELECT version()`;
    const pgVersion = String(pgVersionRows?.version ?? "unknown");

    // ---- Seed (system provisioning context) ----

    const tenant = await prisma.tenant.create({
      data: { name: `ai-loop-tenant-${stamp}` },
    });
    const otherTenant = await prisma.tenant.create({
      data: { name: `ai-loop-other-${stamp}` },
    });

    const store = await prisma.storeConnection.create({
      data: {
        tenantId: tenant.id,
        platform: "SHOPIFY",
        externalStoreId: `ai-loop-demo-${stamp}.myshopify.com`,
        status: "ACTIVE",
        encryptedAccessToken: encryptSecret(
          "simulated-shopify-token",
          process.env.ENCRYPTION_KEY!,
        ),
        scopes: ["read_orders", "write_orders"],
      },
    });

    const location = await prisma.inventoryLocation.create({
      data: {
        tenantId: tenant.id,
        code: `AI-LOC-${stamp}`,
        name: "AI Loop Warehouse",
      },
    });

    const inventoryItem = await prisma.inventoryItem.create({
      data: {
        tenantId: tenant.id,
        sku: `AI-SKU-${stamp}`,
        name: "AI Loop Item",
      },
    });

    await prisma.inventoryBalance.create({
      data: {
        inventoryItemId: inventoryItem.id,
        locationId: location.id,
        availableQty: 5,
        reservedQty: 0,
      },
    });

    const orderPayload = (
      externalId: string,
      orderNumber: string,
      quantity: number,
    ): NormalizedOrder => ({
      externalOrderId: externalId,
      orderNumber,
      paymentStatus: "paid",
      fulfillmentStatus: "unfulfilled",
      totalAmount: String(quantity * 10),
      currency: "USD",
      orderedAt: new Date(),
      cancelled: false,
      lines: [
        {
          externalLineItemId: `${externalId}-line`,
          externalItemRef: null,
          sku: inventoryItem.sku,
          title: "AI Loop Item",
          quantity,
          unitPrice: "10.00",
        },
      ],
    });

    // ============================================================
    // (1) DETECT — the real intake path. Order A reserves cleanly and
    // then sits HELD (NEW, 5 units ACTIVE — not yet fulfillable/abandoned).
    // Order B for the same SKU then fails the real reservation path
    // (all-or-nothing) and raises the OperationalException automatically:
    // a real operational exception caused by held stock.
    // ============================================================

    const heldOrder = await prisma.runAsTenant(tenant.id, () =>
      orderService.upsertFromChannel({
        tenantId: tenant.id,
        storeId: store.id,
        order: orderPayload(
          `shopify-held-${stamp}`,
          `#AI-HELD-${stamp}`,
          5,
        ),
      }),
    );

    const heldReservation = await prisma.inventoryReservation.findMany({
      where: { orderId: heldOrder.id },
    });

    assert(
      heldReservation.length === 1 &&
        heldReservation[0]!.status === "ACTIVE" &&
        heldReservation[0]!.quantity === 5,
      "held order did not reserve 5 units as expected",
    );

    let failure: OrderBusinessFailureError | null = null;

    try {
      await prisma.runAsTenant(tenant.id, () =>
        orderService.upsertFromChannel({
          tenantId: tenant.id,
          storeId: store.id,
          order: orderPayload(
            `shopify-blocked-${stamp}`,
            `#AI-BLOCKED-${stamp}`,
            8,
          ),
        }),
      );
    } catch (error) {
      if (error instanceof OrderBusinessFailureError) {
        failure = error;
      } else {
        throw error;
      }
    }

    assert(failure, "blocked order did not raise an OrderBusinessFailureError");

    const failedOrder = await prisma.order.findUniqueOrThrow({
      where: { id: failure!.orderId },
    });

    assert(
      failedOrder.status === OrderStatus.FAILED,
      `blocked order is ${failedOrder.status}, expected FAILED`,
    );

    const exception = await prisma.operationalException.findUniqueOrThrow({
      where: { id: failure!.exceptionId },
    });

    assert(exception.status === "OPEN", "detected exception is not OPEN");

    // The operational state the release action must fix: the HELD order's
    // 5-unit reservation is still ACTIVE (nothing auto-released it).
    const stuckReservations = await prisma.inventoryReservation.findMany({
      where: { orderId: heldOrder.id },
    });

    assert(
      stuckReservations.length === 1 &&
        stuckReservations[0]!.status === "ACTIVE" &&
        stuckReservations[0]!.quantity === 5,
      "expected the held order's 5-unit reservation to still be ACTIVE",
    );

    // ============================================================
    // (2) INVESTIGATE + (3) PROPOSE — real tool loop, scripted model.
    // The tools themselves execute against real rows.
    // ============================================================

    const noteText = `TechMart: order #AI-BLOCKED-${stamp} could not be reserved — stock is held by order #AI-HELD-${stamp}; held for operator review.`;

    scriptedLlm.setScript([
      {
        toolCalls: [
          {
            name: "get_exception_context",
            arguments: { exceptionId: exception.id },
          },
          {
            name: "get_inventory_truth",
            arguments: { sku: inventoryItem.sku },
          },
        ],
      },
      {
        toolCalls: [
          {
            name: "submit_decision_proposal",
            arguments: {
              actionType: "ADD_ORDER_NOTE",
              targetEntityType: "ORDER",
              targetEntityId: failedOrder.id,
              params: { note: noteText },
              confidence: 0.9,
              basis: "HEURISTIC",
              riskTier: "LOW",
              reasoningSummary:
                "The order is held after a failed reservation; a note explains the hold to the merchant.",
              evidenceRefs: [exception.id, failedOrder.id],
            },
          },
        ],
      },
    ]);

    const investigationA = await prisma.runAsTenant(tenant.id, () =>
      investigationService.investigate({
        tenantId: tenant.id,
        storeId: store.id,
        exceptionId: exception.id,
      }),
    );

    assert(
      investigationA.status === "COMPLETED" && investigationA.proposalId,
      `investigation A is ${investigationA.status}: ${investigationA.error ?? ""}`,
    );

    const investigationRow = await prisma.aiInvestigation.findUniqueOrThrow({
      where: { id: investigationA.investigationId },
      include: { toolCalls: true },
    });

    assert(
      investigationRow.status === "COMPLETED" &&
        investigationRow.toolCalls.length >= 2,
      "investigation trace (tool calls) was not persisted",
    );

    const noteProposal = await prisma.aiDecisionProposal.findUniqueOrThrow({
      where: { id: investigationA.proposalId! },
    });

    assert(
      noteProposal.status === "PROPOSED" &&
        noteProposal.actionType === "ADD_ORDER_NOTE" &&
        noteProposal.targetEntityId === failedOrder.id,
      "ADD_ORDER_NOTE proposal not persisted correctly",
    );

    // Second investigation: release the HELD order's reservation so the
    // blocked order can be re-reserved — the inventory-state resolution.
    scriptedLlm.setScript([
      {
        toolCalls: [
          {
            name: "get_exception_context",
            arguments: { exceptionId: exception.id },
          },
        ],
      },
      {
        toolCalls: [
          {
            name: "submit_decision_proposal",
            arguments: {
              actionType: "RELEASE_ORDER_RESERVATION",
              targetEntityType: "ORDER",
              targetEntityId: heldOrder.id,
              params: {},
              confidence: 0.95,
              basis: "HEURISTIC",
              riskTier: "HIGH",
              reasoningSummary:
                "The held order's reservation is blocking new orders; releasing it restores availability.",
              evidenceRefs: [exception.id, heldOrder.id],
            },
          },
        ],
      },
    ]);

    const investigationB = await prisma.runAsTenant(tenant.id, () =>
      investigationService.investigate({
        tenantId: tenant.id,
        storeId: store.id,
        exceptionId: exception.id,
      }),
    );

    assert(
      investigationB.status === "COMPLETED" && investigationB.proposalId,
      `investigation B is ${investigationB.status}: ${investigationB.error ?? ""}`,
    );

    const releaseProposalId = investigationB.proposalId!;

    // ============================================================
    // (4) AUTHORIZE — approval policy boundaries.
    // ============================================================

    // (4a) Cross-tenant access is invisible (RLS).
    const foreignProposal = await prisma.runAsTenant(otherTenant.id, () =>
      decisionService.getProposal({
        tenantId: otherTenant.id,
        storeId: store.id,
        proposalId: releaseProposalId,
      }),
    ).catch((error: unknown) => error as Error);

    assert(
      foreignProposal instanceof Error &&
        /not found/i.test(foreignProposal.message),
      "cross-tenant read of a proposal must be not-found under RLS",
    );

    // (4b) RELEASE_ORDER_RESERVATION is human-only: a SYSTEM approve is
    // refused at the chokepoint and the proposal stays PROPOSED for the
    // human's renewed authorization.
    const systemApprove = await prisma.runAsTenant(tenant.id, () =>
      decisionService.approve({
        tenantId: tenant.id,
        storeId: store.id,
        proposalId: releaseProposalId,
        actorId: "autonomy-system",
        actorType: AuditActorType.SYSTEM,
      }),
    ).catch((error: unknown) => error as Error);

    assert(
      systemApprove instanceof Error &&
        /human approval/i.test(systemApprove.message),
      "SYSTEM approval of RELEASE_ORDER_RESERVATION must be refused",
    );

    const stillProposed = await prisma.aiDecisionProposal.findUniqueOrThrow({
      where: { id: releaseProposalId },
    });

    assert(
      stillProposed.status === "PROPOSED",
      "refused SYSTEM approval must leave the proposal PROPOSED",
    );

    // (4c) Human approval executes — with exact effects.
    const balanceBefore = await prisma.inventoryBalance.findUniqueOrThrow({
      where: {
        inventoryItemId_locationId: {
          inventoryItemId: inventoryItem.id,
          locationId: location.id,
        },
      },
    });
    const movementCountBefore = await prisma.inventoryMovement.count({
      where: { orderId: heldOrder.id },
    });

    const releaseResult = await prisma.runAsTenant(tenant.id, () =>
      decisionService.approve({
        tenantId: tenant.id,
        storeId: store.id,
        proposalId: releaseProposalId,
        actorId: "ops-human",
        note: "Approved after review: release the stuck reservation.",
      }),
    );

    assert(
      releaseResult.executed === true && releaseResult.verified === true,
      `human-approved release did not execute+verify (error: ${
        (releaseResult as { error?: string }).error ?? "none"
      })`,
    );

    const releasedRow = await prisma.inventoryReservation.findUniqueOrThrow({
      where: { id: stuckReservations[0]!.id },
    });

    assert(
      releasedRow.status === "RELEASED",
      `reservation is ${releasedRow.status}, expected RELEASED`,
    );

    const balanceAfter = await prisma.inventoryBalance.findUniqueOrThrow({
      where: {
        inventoryItemId_locationId: {
          inventoryItemId: inventoryItem.id,
          locationId: location.id,
        },
      },
    });

    assert(
      balanceAfter.availableQty === balanceBefore.availableQty + 5 &&
        balanceAfter.reservedQty === balanceBefore.reservedQty - 5,
      `exact balance effect wrong: available ${balanceBefore.availableQty}->${balanceAfter.availableQty}, reserved ${balanceBefore.reservedQty}->${balanceAfter.reservedQty}`,
    );

    const releaseMovements = await prisma.inventoryMovement.findMany({
      where: { orderId: heldOrder.id, type: "RELEASE" },
    });

    assert(
      releaseMovements.length === 1 && movementCountBefore === 1,
      `expected exactly one RESERVATION and one RELEASE movement, got ${movementCountBefore} total before and ${releaseMovements.length} RELEASE`,
    );

    assert(
      releaseMovements[0]!.reservationId === stuckReservations[0]!.id &&
        releaseMovements[0]!.quantity === 5,
      "RELEASE movement does not match the released reservation (id/quantity)",
    );

    // ---- (4d) Idempotent replay: repeated execution is a no-op ----

    const replay = await prisma.runAsTenant(tenant.id, () =>
      decisionService.approve({
        tenantId: tenant.id,
        storeId: store.id,
        proposalId: releaseProposalId,
        actorId: "ops-human",
      }),
    );

    assert(
      (replay as { replayed?: boolean }).replayed === true &&
        (replay as { executed?: boolean }).executed === true,
      "re-approve of an EXECUTED proposal must replay idempotently",
    );

    const movementsAfterReplay = await prisma.inventoryMovement.count({
      where: { orderId: heldOrder.id, type: "RELEASE" },
    });

    assert(
      movementsAfterReplay === 1,
      "idempotent replay must not execute the release twice",
    );

    // ============================================================
    // (5) CROSS-SYSTEM EXECUTION + (6) EXTERNAL VERIFICATION —
    // SIMULATED Shopify HTTP boundary, REAL adapter code.
    // ============================================================

    const noteResult = await prisma.runAsTenant(tenant.id, () =>
      decisionService.approve({
        tenantId: tenant.id,
        storeId: store.id,
        proposalId: noteProposal.id,
        actorId: "ops-human",
      }),
    );

    assert(
      noteResult.executed === true && noteResult.verified === true,
      `ADD_ORDER_NOTE did not execute+verify (error: ${
        (noteResult as { error?: string }).error ?? "none"
      })`,
    );

    const gid = `gid://shopify/Order/${`shopify-blocked-${stamp}`}`;

    assert(
      simulator.notes.get(gid) === noteText,
      "simulated external note does not match what was written",
    );

    const externalOps = simulator.log.filter((entry) => entry.gid === gid);

    assert(
      externalOps.some((e) => e.op === "orderUpdate") &&
        externalOps.some((e) => e.op === "orderRead"),
      "verify() must independently re-read external state after execute()",
    );

    // ============================================================
    // FAILURE BOUNDARIES (safeguard 6)
    // ============================================================

    // ---- (7) EXECUTION boundary: stale proposal vs changed state ----

    // A separate order whose inventory has ADVANCED (COMMITTED): a
    // release proposal naming it (model error or stale proposal) must
    // fail safely at the pre-execution revalidation — no mutation.
    const orderC = await prisma.runAsTenant(tenant.id, () =>
      orderService.upsertFromChannel({
        tenantId: tenant.id,
        storeId: store.id,
        order: orderPayload(
          `shopify-order-c-${stamp}`,
          `#AI-C-${stamp}`,
          1,
        ),
      }),
    );

    await prisma.runAsTenant(tenant.id, () =>
      inventoryService.commitOrder({
        tenantId: tenant.id,
        storeId: store.id,
        orderId: orderC.id,
      }),
    );

    scriptedLlm.setScript([
      {
        toolCalls: [
          {
            name: "submit_decision_proposal",
            arguments: {
              actionType: "RELEASE_ORDER_RESERVATION",
              targetEntityType: "ORDER",
              targetEntityId: orderC.id,
              params: {},
              confidence: 0.6,
              basis: "HEURISTIC",
              riskTier: "HIGH",
              reasoningSummary:
                "Stale/incorrect proposal naming an order whose inventory has advanced.",
              evidenceRefs: [exception.id],
            },
          },
        ],
      },
    ]);

    const investigationC = await prisma.runAsTenant(tenant.id, () =>
      investigationService.investigate({
        tenantId: tenant.id,
        storeId: store.id,
        exceptionId: exception.id,
      }),
    );

    const staleApprove = await prisma.runAsTenant(tenant.id, () =>
      decisionService.approve({
        tenantId: tenant.id,
        storeId: store.id,
        proposalId: investigationC.proposalId!,
        actorId: "ops-human",
      }),
    );

    assert(
      staleApprove.executed === false &&
        /revalidation/i.test(String((staleApprove as { error?: string }).error)),
      `stale proposal must fail safely at revalidation, got: ${JSON.stringify(
        staleApprove,
      )}`,
    );

    const orderCReservations = await prisma.inventoryReservation.findMany({
      where: { orderId: orderC.id },
    });

    assert(
      orderCReservations.every((r) => r.status === "COMMITTED"),
      "stale proposal must not mutate COMMITTED reservations",
    );

    // ---- (8) VERIFICATION boundary: external state disagrees ----

    const mismatchNote = `TechMart: verification-mismatch probe ${stamp}.`;

    scriptedLlm.setScript([
      {
        toolCalls: [
          {
            name: "submit_decision_proposal",
            arguments: {
              actionType: "ADD_ORDER_NOTE",
              targetEntityType: "ORDER",
              targetEntityId: failedOrder.id,
              params: { note: mismatchNote },
              confidence: 0.9,
              basis: "HEURISTIC",
              riskTier: "LOW",
              reasoningSummary: "Note write whose external verification will disagree.",
              evidenceRefs: [exception.id],
            },
          },
        ],
      },
    ]);

    const investigationD = await prisma.runAsTenant(tenant.id, () =>
      investigationService.investigate({
        tenantId: tenant.id,
        storeId: store.id,
        exceptionId: exception.id,
      }),
    );

    simulator.armVerifyMismatch(mismatchNote);

    const mismatchResult = await prisma.runAsTenant(tenant.id, () =>
      decisionService.approve({
        tenantId: tenant.id,
        storeId: store.id,
        proposalId: investigationD.proposalId!,
        actorId: "ops-human",
      }),
    );

    simulator.disarmVerifyMismatch();

    assert(
      mismatchResult.executed === true &&
        mismatchResult.verified === false &&
        mismatchResult.status === "EXECUTION_FAILED",
      "executed-but-unverified action must land EXECUTION_FAILED",
    );

    const mismatchAudits = await prisma.auditEvent.findMany({
      where: {
        entityId: investigationD.proposalId!,
        action: "AI_PROPOSAL_EXECUTION_VERIFICATION_FAILED",
      },
    });

    assert(
      mismatchAudits.length === 1,
      "verification failure must be audited as AI_PROPOSAL_EXECUTION_VERIFICATION_FAILED",
    );

    // ---- (9) INVESTIGATION + PROPOSAL-CREATION boundaries ----

    // (9a) Model keeps submitting schema-invalid proposals → FAILED,
    // zero proposals persisted.
    scriptedLlm.setScript([
      {
        toolCalls: [
          {
            name: "submit_decision_proposal",
            arguments: {
              actionType: "RELEASE_ORDER_RESERVATION",
              targetEntityType: "OPERATIONAL_EXCEPTION",
              targetEntityId: exception.id,
              params: {},
              confidence: 0.9,
              basis: "HEURISTIC",
              riskTier: "HIGH",
              reasoningSummary: "Invalid: wrong target entity type.",
            },
          },
        ],
      },
      {
        toolCalls: [
          {
            name: "submit_decision_proposal",
            arguments: {
              actionType: "RELEASE_ORDER_RESERVATION",
              targetEntityType: "OPERATIONAL_EXCEPTION",
              targetEntityId: exception.id,
              params: {},
              confidence: 0.9,
              basis: "HEURISTIC",
              riskTier: "HIGH",
              reasoningSummary: "Still invalid.",
            },
          },
        ],
      },
      {
        toolCalls: [
          {
            name: "submit_decision_proposal",
            arguments: {
              actionType: "RELEASE_ORDER_RESERVATION",
              targetEntityType: "OPERATIONAL_EXCEPTION",
              targetEntityId: exception.id,
              params: {},
              confidence: 0.9,
              basis: "HEURISTIC",
              riskTier: "HIGH",
              reasoningSummary: "Invalid again.",
            },
          },
        ],
      },
    ]);

    const invalidRun = await prisma.runAsTenant(tenant.id, () =>
      investigationService.investigate({
        tenantId: tenant.id,
        storeId: store.id,
        exceptionId: exception.id,
      }),
    );

    assert(
      invalidRun.status === "FAILED" && !invalidRun.proposalId,
      "repeated invalid proposals must fail the investigation",
    );

    const invalidRow = await prisma.aiInvestigation.findUniqueOrThrow({
      where: { id: invalidRun.investigationId },
    });

    assert(
      invalidRow.status === "FAILED" &&
        /invalid decision proposal/i.test(String(invalidRow.error)),
      `investigation failure not recorded correctly: ${invalidRow.error}`,
    );

    // (9b) Model corrects after one rejection → proposal persisted
    // (the schema guard actively protects proposal creation).
    scriptedLlm.setScript([
      {
        toolCalls: [
          {
            name: "submit_decision_proposal",
            arguments: {
              actionType: "RELEASE_ORDER_RESERVATION",
              targetEntityType: "OPERATIONAL_EXCEPTION",
              targetEntityId: exception.id,
              params: {},
              confidence: 0.9,
              basis: "HEURISTIC",
              riskTier: "HIGH",
              reasoningSummary: "First attempt: wrong target.",
            },
          },
        ],
      },
      {
        toolCalls: [
          {
            name: "submit_decision_proposal",
            arguments: {
              actionType: "ADD_ORDER_NOTE",
              targetEntityType: "ORDER",
              targetEntityId: failedOrder.id,
              params: { note: `TechMart correction probe ${stamp}.` },
              confidence: 0.8,
              basis: "HEURISTIC",
              riskTier: "LOW",
              reasoningSummary: "Corrected after schema rejection.",
            },
          },
        ],
      },
    ]);

    const correctedRun = await prisma.runAsTenant(tenant.id, () =>
      investigationService.investigate({
        tenantId: tenant.id,
        storeId: store.id,
        exceptionId: exception.id,
      }),
    );

    assert(
      correctedRun.status === "COMPLETED" && correctedRun.proposalId,
      "corrected resubmission must complete with a proposal",
    );

    // (9c) LLM transport failure → investigation FAILED, never throws.
    scriptedLlm.setThrowOnce("simulated LLM transport failure");

    const throwRun = await prisma.runAsTenant(tenant.id, () =>
      investigationService.investigate({
        tenantId: tenant.id,
        storeId: store.id,
        exceptionId: exception.id,
      }),
    );

    assert(
      throwRun.status === "FAILED" &&
        /simulated LLM transport failure/i.test(String(throwRun.error)),
      "LLM failure must surface as a FAILED investigation result",
    );

    // ============================================================
    // (10) RLS + AUDIT CHAIN (safeguard 2)
    // ============================================================

    const foreignProposals = await prisma.runAsTenant(otherTenant.id, () =>
      prisma.aiDecisionProposal.findMany({
        where: { exceptionId: exception.id },
      }),
    );
    const foreignInvestigations = await prisma.runAsTenant(otherTenant.id, () =>
      prisma.aiInvestigation.findMany({
        where: { exceptionId: exception.id },
      }),
    );
    const ownProposals = await prisma.runAsTenant(tenant.id, () =>
      prisma.aiDecisionProposal.findMany({
        where: { exceptionId: exception.id },
      }),
    );

    assert(foreignProposals.length === 0, "RLS leaked proposals across tenants");
    assert(
      foreignInvestigations.length === 0,
      "RLS leaked investigations across tenants",
    );
    assert(ownProposals.length >= 4, "owner tenant cannot see its proposals");

    // The continuous audit chain for the executed release.
    const releaseAudit = (
      await prisma.auditEvent.findMany({
        where: { entityId: releaseProposalId },
        orderBy: { occurredAt: "asc" },
      })
    ).map((event) => event.action);

    assert(
      releaseAudit.includes("AI_PROPOSAL_APPROVED") &&
        releaseAudit.includes("AI_PROPOSAL_EXECUTED"),
      `release audit chain incomplete: ${releaseAudit.join(",")}`,
    );

    const noteAudit = (
      await prisma.auditEvent.findMany({
        where: { entityId: noteProposal.id },
        orderBy: { occurredAt: "asc" },
      })
    ).map((event) => event.action);

    assert(
      noteAudit.includes("AI_PROPOSAL_APPROVED") &&
        noteAudit.includes("AI_PROPOSAL_EXECUTED"),
      `note audit chain incomplete: ${noteAudit.join(",")}`,
    );

    console.log(
      JSON.stringify(
        {
          result: "PASS",
          postgres: pgVersion.split(" on ")[0],
          chain: {
            exceptionId: exception.id,
            investigationA: investigationA.investigationId,
            noteProposal: noteProposal.id,
            releaseProposal: releaseProposalId,
            staleProposal: investigationC.proposalId,
            mismatchProposal: investigationD.proposalId,
          },
          exactEffects: {
            reservation: `${stuckReservations[0]!.status}->RELEASED (qty 5)`,
            balance: `available ${balanceBefore.availableQty}->${balanceAfter.availableQty}, reserved ${balanceBefore.reservedQty}->${balanceAfter.reservedQty}`,
            releaseMovements: releaseMovements.length,
            idempotentReplayMovements: movementsAfterReplay,
          },
          externalBehavior: {
            shopifyGraphQL: "SIMULATED at the HTTP boundary only",
            adapterCode: "REAL (scope checks, GraphQL construction, verify re-read)",
            verifiedAgainstShopifyServers: false,
          },
          failureBoundaries: {
            investigation: ["invalid-proposals FAILED", "LLM-throw FAILED"],
            proposalCreation: ["schema rejection + corrected resubmission"],
            approval: ["cross-tenant not-found", "SYSTEM refused (human-only)"],
            execution: ["stale COMMITTED state refused at revalidation"],
            verification: ["external note mismatch -> EXECUTION_FAILED"],
          },
          auditChains: { release: releaseAudit, note: noteAudit },
          rls: "ok",
        },
        null,
        2,
      ),
    );
  } finally {
    simulator.restore();
    await app.close();
  }
}

tenantContextStorage
  .run({ bypass: true }, () => main())
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
