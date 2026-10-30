# TechMart — Phase 2A: Enterprise Intelligence Runtime Architecture Assessment

**Status:** assessment and design only — no code, schema, dependency, or wiring changes are made by this document.
**Grounding:** every finding references actual repository files/classes/methods at branch `arena/017dc6c2-oms`, HEAD `4bd9477`.
**Product boundary (permanent):** TechMart is an operational intelligence and action layer over existing OMS/WMS/ERP/channel systems — never a replacement OMS/WMS/ERP/connector platform. The Intelligence Runtime below is the shared machinery for investigation, evidence, decision, policy, authorization, execution, verification, evaluation, and learning across domains (orders, inventory, fulfillment, shipping, returns, reconciliation, future ERP) — not a new business system.

---

## 1. Current-state architecture map

### 1.1 Runtime topology (as built)

```
External systems of record (Shopify, WMS, shipping carriers — future ERP)
   │  webhooks / adapters (src/connectors, src/shopify, src/wms/fake, src/shipping/fake)
   ▼
Event intake ──► BullMQ queues (src/queue/queue.module.ts, attempts:5 + backoff)
   │              WebhookWorker (src/queue/webhook.worker.ts)
   ▼
OMS domain services (authoritative mutations)
   OrderModule · InventoryModule · FulfillmentModule · ShippingModule · WmsModule
   │  detection (deterministic rules — never AI)
   ▼
Exception layer (src/oms/exception/exception.service.ts)
   fingerprint upsert (storeId_fingerprint unique) → OperationalException
   │  enqueue for AI-eligible categories (exception.service.ts:93)
   ▼
AI investigation pipeline (src/ai)
   AiInvestigationWorker (BullMQ) → AiInvestigationService.investigate()
   │   ├─ LlmClient port (LLM_CLIENT): GroqLlmClient | ScriptedLlmClient (tests)
   │   ├─ AiToolsService — 6 read tools, (tenantId, storeId) scoped
   │   │     └─ wraps OMS reads: ExceptionService, InventoryTruthService,
   │   │        prisma reads (past exceptions), AuditService, AiMemoryService
   │   ├─ evidence ledger: AiToolCall rows (input/output per call)
   │   ├─ D2 provenance gate (checkProposalGrounding; isTrustedEvidenceOutput)
   │   └─ submit_decision_proposal (zod: ai-decision-proposal.schema.ts)
   ▼
AiDecisionProposal (PROPOSED → APPROVED|REJECTED → EXECUTED|EXECUTION_FAILED)
   │   human approval chokepoint: AiDecisionService.approve()
   │   ├─ idempotent replay, revalidateBeforeExecution (store-fenced)
   │   ├─ AiAutonomyService.maybeAutoExecute (opt-in, allowlisted, rate-limited)
   │   ▼
AiActuationService.execute → ActionAdapter (ShopifyActionAdapter)
   → AiDecisionService.verifyAction (independent re-read → EXECUTION_FAILED on mismatch)
   → AiOutcomeFeedback + AiMemoryService.recordProposalOutcome
   ▲
Parallel advisory track (Task 12, not wired to actions):
   DECISION_MODEL port (src/ai/decision-model) — Jev adapter / scripted / deterministic
   baseline + redaction allowlist + offline comparison runner + labelled fixtures
Cross-cutting:
   TenantApiKeyGuard · TenantRlsInterceptor · tenantContextStorage (AsyncLocalStorage)
   PostgreSQL RLS (prisma/migrations/20260822161416_enable_row_level_security)
   AuditService/AuditEvent (every AI transition + every domain mutation)
Evaluation:
   InvestigationEvaluationService (10 criteria) · InvestigationHarnessService
   fixtures/investigation-evaluation/corpus.json (21 labelled cases, dev/holdout)
   fixtures/decision-model/ (32-case labels + golden) · 6 real-DB acceptance scripts
```

### 1.2 Capability inventory (actual implementation → tests)

| Capability | Actual implementation | Interfaces / contracts | Tests |
|---|---|---|---|
| Investigation lifecycle | `AiInvestigationService.investigate/runInvestigation/runToolLoop/markFailed` (`src/ai/investigation/ai-investigation.service.ts`); D1 cancellation: guarded `updateMany(status=RUNNING)` claim + `$transaction` proposal commit + `clearTimeout` | `InvestigateInput/InvestigateResult` (same file) | `ai-investigation.service.spec.ts` (timeout, single-row, late-proposal, claim-race, grounding) |
| Async dispatch | `AiInvestigationQueueService.enqueue`, `AiInvestigationWorker.process` (`src/ai/queue/`); categories `AI_ELIGIBLE_EXCEPTION_CATEGORIES` | `AiInvestigationJobData` | real-DB `ai-action-loop-real-db-test.ts` |
| Evidence collection | `AiToolsService` (`src/ai/tools/ai-tools.service.ts`): `get_exception_context`, `get_inventory_truth`, `get_order_detail`, `get_similar_past_exceptions`, `get_tenant_memory`, `get_audit_history`; ledger `AiToolCall` | `AiToolContext {tenantId, storeId}`; file-header contract: "scoped to tenantId/storeId exactly like every other query" | `ai-investigation.service.spec.ts`, `inventory-truth.service.spec.ts` |
| Evidence provenance | `isTrustedEvidenceOutput` + `checkProposalGrounding` (`ai-decision-proposal.schema.ts`, `ai-investigation.service.ts`); evaluator mirror (`investigation-evaluation.service.ts` `assessGrounding`) | shared provenance rule; uncertainty-class exception (`UNCERTAINTY_ACTION_TYPES`) | adversarial corpus cases (`adversarial_grounding`), input-echo/failed-output/cross-store unit tests |
| Canonical inventory truth | `InventoryTruthService.getSkuTruth` (`src/oms/inventory/inventory-truth.service.ts`): tenant-wide aggregates + scoped `reservations` + `reservationsScope` + `unexplained*Qty` | `InventoryTruth`, `InventoryTruthReservation` | `inventory-truth.service.spec.ts`, `inventory-truth-real-db-test.ts` |
| Decision proposal contract | `ai-decision-proposal.schema.ts` (zod; `decisionProposalSchema`, `REQUIRED_TARGET_ENTITY_TYPE`) | `submit_decision_proposal` tool definition | proposal-schema paths in `ai-investigation.service.spec.ts` |
| Decision-model port + Jev | `DECISION_MODEL` symbol + `DecisionModel` (`decision-model.interface.ts`); zod wire schemas verified against Typesafe OpenAPI 3.1.0 (`decision-model.types.ts`); `JevDecisionModel` (AbortController, 100–5000 ms clamp) | per-use-case typed questions/answers | 34 tests across 5 specs (`src/ai/decision-model/*.spec.ts`) |
| Deterministic baseline | `decision-baseline.ts` (detector-logic classification, flat-HIGH urgency, routing heuristic) | `BaselineDecision` | `decision-model-comparison.spec.ts` pinned numbers |
| Redaction | `decision-redaction.ts` (frozen per-use-case transmitted-field allowlist + excerpt redaction) | exported allowlists | `decision-redaction.spec.ts` (safety-invariants source-scan) |
| Policy / autonomy | `AiAutonomyPolicyService` (per-tenant per-actionType policy, `countRecentAutoExecutions`); `AiAutonomyService.maybeAutoExecute` (opt-in allowlist, low-risk only) | `AiAutonomyPolicy` model | `ai-autonomy.service.spec.ts` |
| Authorization | `TenantApiKeyGuard`, `TenantRlsInterceptor`, `tenantContextStorage` (`src/prisma/tenant-context.ts`), RLS migration (tenant-only `tenant_isolation` policies) | `TenantRlsContext` | `tenant-api-key.guard.spec.ts`, `prisma.service.spec.ts`, `rls:"ok"` in real-DB suites |
| Human approval | `AiDecisionService.approve` (idempotent replay of decided proposals) — the single execution chokepoint (`src/ai/decision/ai-decision.service.ts`) | `ApproveProposalInput` | `ai-decision.service.spec.ts`, `ai-action-loop-real-db-test.ts` (SYSTEM-approval refusal) |
| Execution | `AiActuationService.execute/verify` + `ActionAdapter` port + `ShopifyActionAdapter` (`src/ai/actuation/`) | `ActionAdapterInput/Result`, `ACTION_ADAPTERS` registry | `ai-actuation.service.spec.ts`, `shopify-action.adapter.spec.ts` |
| Pre-execution revalidation | `AiDecisionService.revalidateBeforeExecution` — store-fenced order lookup + COMMITTED/SHIPPED reservation guard | throws → `EXECUTION_FAILED` | `ai-decision.service.spec.ts`, action-loop scenario 7 |
| Independent verification | `AiDecisionService.verifyAction` (re-reads external state; mismatch → `EXECUTION_FAILED`) | `AiOutcomeFeedback` rows | action-loop scenario 8 (verify-mismatch) |
| Exception detection (deterministic) | `OrderFailureDetectorService.detect` → `OrderFailureExceptionService.detectAndRaise` (flat `ExceptionSeverity.HIGH`); `RiskDetectorService.detect` (inventory/reservation/fulfillment/shipment/order families + `raise`) | `OperationalException` + fingerprint identity | `order-failure-detector.service.spec.ts`, `order-failure-exception.service.spec.ts`, `risk-detector.service.spec.ts`, `order-failure-exception-real-db-test.ts` |
| Human resolution | `ResolutionService.claim/resolve` + `verifyOrderReservationReleased` (`src/oms/resolution/resolution.service.ts`) | `ResolutionContext/Action/Result` | `resolution.service.spec.ts` |
| Operational memory | `AiMemoryService.recordProposalOutcome/getCurrentFacts` (`src/ai/memory/ai-memory.service.ts`), `AiMemoryFact` model | category-scoped facts | `ai-memory.service.spec.ts` |
| Past-incident retrieval | `getSimilarPastExceptions` (`ai-tools.service.ts:278`, SQL category/sku filters, tenant+store scoped) | tool contract | action-loop + evaluation runs |
| Event processing / recovery | BullMQ (`src/queue/queue.module.ts`: attempts 5, exponential backoff, `removeOnComplete`), `WebhookWorker` attempt logging, WMS/shipping event queues + processors (fake adapters retained) | `ReceivedWebhookEvent`, WMS/shipping request contracts | `webhook.worker.spec.ts`, `webhook-processor` specs, wms/shipping real-DB suites |
| Evaluation | `InvestigationEvaluationService` (10 criteria incl. `low_confidence_flagged`), `InvestigationHarnessService.seedScenario/runScenario`, corpus integrity spec (dev/holdout, near-duplicate ≤ 0.9 Jaccard) | `InvestigationEvaluationReport` | `investigation-evaluation.service.spec.ts`, `investigation-evaluation-corpus.spec.ts`, `investigation-harness.service.spec.ts` |
| Model-comparison governance | `decision-model-comparison-run.ts` (offline runner `--engine=none|scripted|jev`; jev refuses without `--allow-live`), `ScriptedDecisionModel` | `gateAssessment` (pilot-level only) | comparison spec + runner dry runs |
| Audit | `AuditService.recordEvent/getEntityHistory/getTenantHistory` (`src/oms/audit/audit.service.ts`), `AuditEvent` | actor/entity/metadata contract | covered across suites; `ai-action-loop` audit assertions |
| Configuration | `src/config/environment.ts` (validated env: AI budgets/timeouts, `DECISION_MODEL_ENGINE`, `JEV_*`), `redis-connection.ts` | `validateEnvironment` | `environment.spec.ts` |

**Counts at HEAD:** 60 spec files / 485 unit+integration tests (vitest); 6 real-PostgreSQL acceptance scripts + `seed-lab-db.ts` (reproducible provision); fixtures: `investigation-evaluation/corpus.json` (21 labelled cases), `decision-model/exception-triage.labels.json` (32 cases, 16 dev/16 holdout), `decision-model/scripted-answers.golden.json`, `shopify-webhooks/`.

---

## 2. Architectural problems

Severity: **S1** = verified defect/risk with operational impact; **S2** = verified inconsistency/tech debt; **S3** = future possibility, not a current defect.

### Verified problems

| # | Severity | Problem | Evidence | Notes |
|---|---|---|---|---|
| P1 | S1 | **LLM provider timeouts are inconsistent and the Groq call is uncancellable.** `JevDecisionModel` clamps timeouts 100–5000 ms with `AbortController` (`jev-decision-model.client.ts`); `GroqLlmClient.createChatCompletion` (`src/ai/llm/groq-llm.client.ts:37`) has **no timeout, no abort, no retry, no rate-limit handling**. A cancelled investigation run (D1) still pays for an in-flight Groq call to completion; hung providers hold the tool loop until process death. | files cited | D1 made terminal writes safe; the I/O itself remains uncancellable — this is the honest residual of Phase 1B §4. |
| P2 | S1 | **AI investigation queue lacks the retry/recovery contract every other queue has.** `AiInvestigationQueueModule` registers a bare queue (`src/ai/queue/ai-investigation-queue.module.ts:17`) — no attempts/backoff/dead-letter — while the webhook path configures `attempts: 5` + backoff (`src/queue/queue.module.ts:44`). Worse, **there is no idempotency key**: `ExceptionService` enqueues at `exception.service.ts:93` and the fingerprint upsert re-opens the same exception on recurrence ("Re-open the same fingerprint", `exception.service.ts:74`) — each recurrence (or worker redelivery) starts a **new** investigation with no in-flight dedupe. | files cited | `investigate()` persists failures internally (worker never throws), so jobs don't retry — that is safe but means **transient** infra failure = permanently lost investigation with no recovery path. Both directions need a contract. |
| P3 | S2 | **Two parallel "investigation" abstractions with overlapping names.** `src/oms/investigation/investigation-context.service.ts` (`getContext`) and `investigation-decision.service.ts` (`InvestigationDecisionService`) implement domain triage context/decisions; `src/ai/investigation/` implements the AI pipeline. Different purposes, ambiguous ownership for newcomers; risk of divergence (e.g., two "context assembly" implementations once domains multiply). | files cited | Not a runtime bug today (the AI pipeline does not call the OMS pair); a naming/ownership contract is missing. |
| P4 | S2 | **AI layer reaches across the OMS boundary unevenly.** `AiToolsService` wraps `ExceptionService`/`AuditService`/`InventoryTruthService` (good) but also queries `prisma.operationalException` directly for `getSimilarPastExceptions` (`ai-tools.service.ts:296`) and `aiMemoryService` facts. The file header acknowledges the exception ("except where no service exists yet"). `AiModule` imports `ExceptionModule` while `ExceptionModule` depends on `AiInvestigationQueueModule` (producer-side split to break the cycle — documented in the queue module header). | files cited | The cycle-avoidance pattern works; the direct-prisma exceptions are the duplication/coupling seed. |
| P5 | S2 | **Inconsistent error/timeout vocabulary across the pipeline.** Investigation failures → `InvestigationResult.error` strings + `markFailed`; provider errors → thrown `InternalServerErrorException` (Groq) vs typed error envelopes (Jev client: `{code, message}` unions); tool errors → `{error: string}` outputs; action errors → `EXECUTION_FAILED` + `error` column. No shared error taxonomy. | `groq-llm.client.ts`, `decision-model.types.ts`, `ai-tools.service.ts`, `ai-decision.service.ts` | Evaluation criteria parse error text (`/invalid decision proposal/i` in `checkSchemaValidity`) — string-coupled contracts. |
| P6 | S2 | **Observability is log-only.** Nest `Logger` throughout; no metrics/tracing exports. Evaluation computes `latencyMs`, `tokenUsage`, `toolCallCount` (`investigation-evaluation.types.ts` `InvestigationMetrics`) but only per-run, in report JSON. Provider cost/rate-limit accounting does not exist (no token budget per tenant; per-run budget `AI_INVESTIGATION_MAX_TOKENS` only). | cited | Blocks the enterprise cost-control requirement (§6) until addressed. |
| P7 | S2 | **Model identity is configuration, not contract.** `AiInvestigation.model` records `GROQ_MODEL` at creation (`ai-investigation.service.ts`, `runInvestigation`) — good — but there is no pinning/registry: changing the env var silently changes behavior; evaluation reports don't record model versions; decision-model `usage` records tokens but nothing links proposal → LLM model version. | cited | Cheap to fix (record + report; pin in config validation). |
| P8 | S2 | **Evidence trust model is tool-level, not attestation-level.** Provenance (D2/1B) guarantees "the id came from a successful tool output of this investigation", but tool outputs are trusted wholesale — a compromised connector could feed false evidence. Explicitly accepted in Phase 1B §Unresolved; must remain an explicit trust boundary in the runtime. | `isTrustedEvidenceOutput` | Not fixable by code alone (connector trust); mitigations: keep adapters deterministic/fake-able, audit tool outputs (already persisted in `AiToolCall`). |
| P9 | S3 | **Cross-domain duplication is a forecast, not yet a defect.** Order-specific detectors (`order-failure-*`, `risk-detector` families) and shipping/WMS status mappings are domain-owned by design (correct today). If returns/reconciliation/ERP domains each re-implement detection→exception→fingerprint and tool registration, duplication becomes real. | `src/oms/order/*`, `src/wms/wms-status-mapping.ts`, `src/shipping/shipping-status-mapping.ts` | Address with thin shared contracts (§3), not by merging domains. |

### Explicitly NOT problems (verified adequate — do not "fix")

- Tenant isolation: RLS + `(tenantId, storeId)` query discipline + `runAsTenant`/`runAsSystem` context (Phase 1D traced; `ai-action-loop` asserts `"rls":"ok"`).
- Proposal provenance: output-only grounding with the uncertainty-class exception (Phases 1B/1D; adversarial corpus).
- Approval chokepoint: one path (`approve()`), idempotent replay, SYSTEM refusal for RELEASE, revalidation before mutation, independent verify.
- Timeout outcome integrity: D1 single-row/single-outcome semantics (Phase 1A/1B tests).
- Inventory scope consistency: tenant-wide aggregates + scoped rows + `unexplained*` markers (Phase 1D).
- Exception identity idempotency: fingerprint upsert (`exception.service.ts` `storeId_fingerprint`).

---

## 3. Target-state design — module boundaries of the shared Intelligence Runtime

### 3.1 Target topology

```
                    ┌────────────────────────────────────────────────┐
                    │           Intelligence Runtime (src/ai)        │
                    │                                                │
  domains ──enqueue─► 1. Lifecycle & Orchestration                   │
  (orders,          │    (investigate / claim / finalize semantics)  │
   inventory, …)    │                                                │
                    │ 2. Context & Evidence      3. Investigation    │
                    │    (EvidenceRecord,           (BoundedToolLoop, │
                    │     ReadTool registry)         LlmClient port)  │
                    │                                                │
                    │ 4. Decision contracts      5. Policy & Authz   │
                    │    (DECISION_MODEL port,      (PolicyGate,      │
                    │     zod use-case schemas)     approval gate)    │
                    │                                                │
                    │ 6. Execution & Verify      7. Memory           │
                    │    (ActionAdapter,            (facts, outcomes, │
                    │     execute/verify/reconcile)  retrieval)       │
                    │                                                │
                    │ 8. Evaluation & Observability                  │
                    └────────────────────────────────────────────────┘
                       ▲ wraps (never replaces) domain services:
                       │  ExceptionService, InventoryTruthService,
                       │  OrderQuery, AuditService, ResolutionService…
                       ▼
                    external actuators (Shopify adapter today; ERP later)
```

### 3.2 Existing-module disposition

| Module (path) | Disposition | Rationale |
|---|---|---|
| `src/ai/investigation/` | **Keep, extract contracts** | Becomes capability 1+3; extract `BoundedToolLoop` + lifecycle state types (§4) without moving domain code |
| `src/ai/tools/ai-tools.service.ts` | **Extend into a ReadTool registry**; move pure-SQL reads behind OMS query services over time | Fixes P4 incrementally; keeps the "(tenantId, storeId) exactly like every other query" contract as the registry invariant |
| `src/ai/investigation/ai-decision-proposal.schema.ts` | **Keep as shared contract home** | Already the provenance-rule home (`isTrustedEvidenceOutput`, `isUncertaintyConclusion`) |
| `src/ai/decision-model/` | **Keep untouched (port pattern)** | The template for all future model routing; no change per Task 12 preservation |
| `src/ai/decision/` (decision, autonomy, autonomy-policy) | **Keep**; wrap the gate trio behind a `PolicyGate` façade | Capability 5; behavior frozen (no autonomy expansion) |
| `src/ai/actuation/` | **Keep**; `ActionAdapter` is already the right seam | Capability 6; new domains add adapters, never touch the engine |
| `src/ai/memory/` + `AiMemoryFact` | **Keep** (PostgreSQL) | Capability 7; retrieval via SQL until measured need (see §5) |
| `src/ai/validation/` + fixtures | **Keep**; becomes capability 8 | Evaluation/harness/corpus are the governance backbone |
| `src/ai/llm/` | **Keep**; harden `GroqLlmClient` to the Jev client's contract | P1; one provider contract, two implementations |
| `src/ai/queue/` | **Keep**; add idempotency + retry contract | P2 |
| `src/oms/investigation/` | **Keep domain-specific; rename/document as domain triage** | P3: e.g. `OrderTriageContext` naming in a later mechanical change; NOT part of the runtime |
| `src/oms/*` domain services | **Stay authoritative** | Runtime wraps them; never re-implements state |
| `src/queue/`, `src/webhooks/`, `src/wms/`, `src/shipping/`, `src/connectors/` | **Stay as-is** | Event/recovery machinery is domain-integration, not runtime |
| `src/auth/`, `src/prisma/tenant-context.ts` | **Stay as-is** | The isolation substrate |

### 3.3 Proposed TypeScript contracts (interfaces only — justified by repeated requirements)

Justification bar: an abstraction is introduced only where ≥2 real call sites or ≥2 domains need identical semantics today.

```ts
// capability 2 — shared by all 6 tools today and every future domain tool
// (src/ai/tools/ai-tools.service.ts already enforces this shape informally)
export interface ReadTool<TArgs = Record<string, unknown>> {
  readonly name: string;
  readonly description: string;
  readonly parameters: JsonSchemaObject;
  /** MUST filter tenantId + storeId; MUST NOT mutate. Returns
   *  isTrustedEvidenceOutput-conforming data or { error }. */
  execute(ctx: AiToolContext, args: TArgs): Promise<ToolResult>;
}

// capability 3 — extract of the existing runToolLoop semantics so future
// domains reuse the SAME bounded loop (budgets, grounding, submit gate)
export interface BoundedToolLoop {
  run(input: {
    investigationId: string;
    context: AiToolContext;
    tools: readonly ReadTool[];
    maxToolCalls: number;
    maxTokens: number;
    signal: AbortSignal;          // completes P1 for every provider
  }): Promise<ToolLoopOutcome>;   // COMPLETED with proposal args | FAILED + typed reason
}

// capability 5 — façade over AiDecisionService.approve + AiAutonomyService
// + AiAutonomyPolicyService; the ONLY door to mutation
export interface PolicyGate {
  authorize(input: {
    proposalId: string;
    actor: { type: "HUMAN" | "SYSTEM"; id: string };
  }): Promise<{ authorized: boolean; reason?: string }>;
}

// capability 6 — already exists as ActionAdapter (src/ai/actuation); the
// runtime adds only the reconcile outcome vocabulary (§4)
export type ExecutionOutcome =
  | { kind: "VERIFIED" }
  | { kind: "EXECUTION_FAILED"; error: string; reconciled: boolean }
  | { kind: "UNCERTAIN"; note: string }; // e.g. timed-out external call

// capability 8 — stable report shape for every domain (exists)
export interface Evaluator {
  evaluate(input: EvaluateInvestigationInput): Promise<InvestigationEvaluationReport>;
}
```

**Deliberately NOT abstracted:** exception detection rules (domain truth), status mappings (per connector), domain services, connector clients, the decision-model wire schemas (per-use-case by design), and anything with a single call site.

---

## 4. Target lifecycle — state transitions and contracts

### 4.1 Stage sequence

```
Detection → Context Assembly → Evidence Retrieval → Investigation →
Decision Proposal → Policy Evaluation → Authorization → Execution →
Independent Verification → Outcome Recording → Evaluation
```

### 4.2 State machines (persisted)

**AiInvestigation** (`enum AiInvestigationStatus`: RUNNING → COMPLETED | FAILED)

| Transition | Guard | Timeout behavior | Idempotency boundary |
|---|---|---|---|
| create (RUNNING) | exception exists (tenant+store scoped) | — | one row per `investigate()` call; queue job SHOULD dedupe (P2 → Phase 2B) |
| RUNNING → COMPLETED | `$transaction`: `updateMany({id, status: RUNNING, tenantId, exceptionId})` count=1 **and** proposal insert (atomic) | loser of the race gets count=0 → no proposal, run reports FAILED | exactly one terminal outcome per row (Phase 1A tests) |
| RUNNING → FAILED | `updateMany({status: RUNNING})` guarded `markFailed`; error string recorded | timeout sets cancel flag + clears timer; late writes no-op | `failWithoutInvestigationRow` only pre-row |

**AiDecisionProposal** (`enum AiDecisionProposalStatus`: PROPOSED → APPROVED | REJECTED → EXECUTED | EXECUTION_FAILED)

| Transition | Guard | Notes |
|---|---|---|
| (implicit) → PROPOSED | D2 grounding + zod schema + bounded retry (≤2 invalid attempts) | created inside the investigation claim transaction |
| PROPOSED → APPROVED | `PolicyGate.authorize`: human actor required for RELEASE (SYSTEM refused — action-loop test); autonomy path only via `AiAutonomyService` policy (opt-in, allowlist, rate-limited) | **human approval boundary**: nothing executes without it or an explicit tenant autonomy policy |
| PROPOSED → REJECTED | human reject | audited |
| APPROVED → EXECUTED | `revalidateBeforeExecution` (store-fenced; COMMITTED/SHIPPED guard) → adapter execute → `verifyAction` independent re-read | verify mismatch ⇒ **EXECUTION_FAILED** (executed-but-unverified is a first-class state) |
| APPROVED → EXECUTION_FAILED | any throw or verify mismatch | error + audit; optional `recordFeedback` |

### 4.3 Stage contracts (I/O) and scoping

| Stage | Input | Output | Scoping / audit |
|---|---|---|---|
| Detection | domain event/state | `OperationalException` (fingerprint identity) | tenant+store; audited; enqueue only for `AI_ELIGIBLE_EXCEPTION_CATEGORIES` |
| Context Assembly | exceptionId | domain context (`InvestigationContextService.getContext` today; future per-domain) | (tenantId, storeId) |
| Evidence Retrieval | tool calls ≤ budget | `AiToolCall` ledger rows (successful outputs = evidence) | every read (tenantId, storeId); error outputs excluded from evidence |
| Investigation | job/HTTP `InvestigateInput` | `InvestigateResult` | one row/call; D1 cancellation; budgets: `AI_INVESTIGATION_MAX_TOOL_CALLS/_MAX_TOKENS/_TIMEOUT_MS` |
| Decision Proposal | submit tool args | `AiDecisionProposal` PROPOSED | grounding + schema + target-type rules (`REQUIRED_TARGET_ENTITY_TYPE`) |
| Policy Evaluation | proposal | policy decision | `AiAutonomyPolicy` (tenant, actionType); `countRecentAutoExecutions` rate limit |
| Authorization | proposal + actor | APPROVED/REJECTED | human chokepoint; idempotent replay |
| Execution | approved proposal | adapter result | **revalidation required immediately before mutation**; adapters are the only external writers |
| Verification | adapter result + fresh reads | VERIFIED / EXECUTION_FAILED | independent re-read (`verifyAction`); verify-mismatch ⇒ EXECUTION_FAILED |
| Outcome Recording | terminal proposal | `AiOutcomeFeedback` + `AiMemoryFact` | `recordProposalOutcome`; audited |
| Evaluation | run rows + trace | `InvestigationEvaluationReport` | 10 criteria; corpus/holdout governance |

**Invariant (non-negotiable):** an AI model can only propose; it can never bypass `PolicyGate`, and `execute`/`verify` are unreachable without an APPROVED proposal. Failures at every stage are typed terminal states, never silent.

**Failure states:** `AiInvestigationStatus.FAILED` (typed reasons: provider failure, timeout, budgets, invalid-proposal exhaustion, ungrounded-proposal exhaustion); `AiDecisionProposalStatus.EXECUTION_FAILED`; queue job failure (post-Phase 2B: retried then dead-lettered). **Timeout behavior:** investigation = logical cancellation with single-outcome guarantee (Phase 1A); provider call = AbortSignal cancellation (Phase 2B target); external action = `UNCERTAIN` outcome vocabulary pending (§3.3) with reconcile.

---

## 5. Technology assessment

| Technology | Decision | Rationale / tradeoff |
|---|---|---|
| **Native NestJS/TypeScript orchestration** | **Yes — keep** | Verified requirements are one bounded tool loop (≤8 calls), a proposal gate, and a policy gate. Nest modules + Prisma + BullMQ already implement them with 485 passing tests. Ports (`LLM_CLIENT`, `DECISION_MODEL`, `ACTION_ADAPTERS`) give substitution without a framework. |
| **LangGraph.js** | **No** | No verified requirement for graph-shaped, stateful, multi-node orchestration; would add a dependency and a parallel state model on top of persisted PG state. Constraint precedent (Task 12) and "no dependency for popularity" both apply. Revisit only if investigation flows become multi-phase graphs with measured pain. |
| **Durable workflow engine (Temporal et al.)** | **Not yet** | Current jobs are seconds-long with single-outcome PG state; BullMQ (attempts/backoff) + guarded transitions cover recovery. Tradeoff accepted: no automatic compensation graphs; our compensation is domain-typed (revalidation refusal, EXECUTION_FAILED, reconcile). Trigger to revisit: workflows spanning days, or ≥3 domains needing saga compensation. |
| **PostgreSQL-backed memory/retrieval** | **Yes — keep** | `AiMemoryFact` + SQL retrieval (`getCurrentFacts`, `getSimilarPastExceptions`) meet verified needs (facts + category/sku incident recall); one database to operate, RLS-compatible. |
| **pgvector** | **Not yet** | Corpus/memory scale (dozens of facts, hundreds of exceptions) does not justify an index; semantic retrieval has no measured failure to fix. Trigger to revisit: recall quality measured poor on holdout at real data volumes. |
| **Separate Python AI service** | **No** | No capability gap: Jev is HTTPS (zero-dep client), Groq via `groq-sdk`, everything else is TS. A second service doubles ops, auth, and provenance surface for zero verified benefit. |
| **Event-driven processing** | **Extend what exists** | Keep BullMQ for webhooks/WMS/shipping/investigation; add the missing idempotency + retry/dead-letter contract to the AI queue (P2). No new broker. |

**Recommended simplest architecture:** current stack + hardened provider contract + queue lifecycle contract + thin shared interfaces (§3.3). Nothing else.

---

## 6. Enterprise-readiness requirements (proposed design)

| Requirement | Design | State |
|---|---|---|
| Tenant isolation & permission boundaries | RLS (`app.tenant_id`) + `TenantRlsInterceptor` + `(tenantId, storeId)` query discipline + store-fenced execution. Runtime rule: every `ReadTool`/`PolicyGate`/adapter call carries `AiToolContext`. | **exists**; keep as registry invariant |
| Evidence provenance | Output-only grounding (`isTrustedEvidenceOutput`), per-investigation ledger (`AiToolCall`), uncertainty-class exception, scope markers (`reservationsScope`, `unexplained*`). | **exists** (1B/1C/1D) |
| Model failure & fallback | Typed provider failure → FAILED investigation with reason; **never** invent a fallback decision (Task 11 constraint). Phase 2B adds AbortSignal + timeouts so failure is fast and bounded. | partial → 2B |
| Confidence & uncertainty | `confidence` + `riskTier` on proposals; `low_confidence_flagged` criterion (HIGH-risk < 0.5 = FAIL); uncertainty conclusions (`ESCALATE_TO_HUMAN`, `NO_ACTION_INSUFFICIENT_EVIDENCE`) as first-class honest outcomes. | **exists** |
| Human approvals | Single chokepoint `approve()`; RELEASE = human-only; idempotent replay; autonomy strictly opt-in per tenant+actionType with rate limits. | **exists** |
| Auditability & traceability | `AuditEvent` for every transition (investigation completed/failed, proposal decided/executed, verify-failed); proposal rows carry provenance (`evidenceRefs`, `basis`, `reasoningSummary`); tool ledger retained. | **exists** |
| Provider rate limits & cost controls | Per-run budgets exist (`AI_INVESTIGATION_MAX_TOKENS`, tool-call cap). **Design:** per-tenant daily token/call budget table + `countRecentAutoExecutions`-style counter enforced in the tool loop; provider 429/529 handling per Jev docs; surface `usage` into `InvestigationMetrics`. | **gap** (P6) |
| Model versioning | Record `model` on `AiInvestigation` (exists); **design:** pin version ids in config validation (Jev: pin `jev-1.x.y`, never aliases), stamp model id into evaluation reports and comparison runs. | partial (P7) |
| Offline evaluation & holdout protection | Corpus with `labelSource` + rationale; dev/holdout split enforced by `investigation-evaluation-corpus.spec.ts` (uniqueness, category coverage, Jaccard < 0.9); decision-model labels fixture with hash/disjointness checks in the comparison runner. | **exists** |
| Shadow execution | Task 12 design: `DECISION_MODEL` advisory-only; comparison runner `--engine=jev` refuses without `--allow-live`; shadow = compare vs baseline on holdout before any proposal-path wiring. | **designed, not wired** (correct) |
| Operational recovery | BullMQ backoff/retry (webhooks); guarded state transitions survive crashes (claim semantics); `seed-lab-db.ts` reproducible provision; dead-letter for AI queue to be added (P2). | partial → 2B |

---

## 7. Risks and architectural gaps — ranked

1. **S1 — Uncancellable provider I/O (P1).** Hung/slow model calls hold workers and consume budget after cancellation. → Phase 2B.
2. **S1 — AI queue has no retry/dead-letter/idempotency (P2).** Transient failure silently drops investigations; recurrence can spawn duplicate concurrent investigations for one exception. → Phase 2B.
3. **S2 — Error/timeout taxonomy inconsistency (P5).** String-coupled evaluation (`/invalid decision proposal/i`) will break silently as providers multiply. → Phase 2C.
4. **S2 — Cost/observability gap (P6).** No tenant-level token accounting; logs only. → Phase 2C (design in §6).
5. **S2 — Model identity/config drift (P7).** → cheap; bundle with 2C.
6. **S2 — Cross-boundary data access in tools (P4).** Direct prisma reads in `getSimilarPastExceptions`/`getAuditHistory`. → opportunistic cleanup as domains are added.
7. **S2 — Naming/ownership overlap of the two investigation concepts (P3).** → mechanical rename/doc when touched.
8. **S2 — Connector trust (P8).** Explicitly accepted; mitigations only.
9. **S3 — Future cross-domain duplication (P9).** Guard with the §3.3 contracts; do not pre-abstract.

---

## 8. Incremental implementation roadmap

| Phase | Scope | Depends on | Acceptance criteria |
|---|---|---|---|
| **2B** (next) | Provider contract hardening + queue lifecycle contract: (a) `GroqLlmClient` AbortSignal + clamped timeout matching `JevDecisionModel` semantics; thread `AbortSignal` from `investigate()` through `runToolLoop`; (b) AI queue: explicit attempts/backoff/dead-letter + **idempotency** (in-flight rule: one RUNNING investigation per (tenantId, storeId, exceptionId) fingerprint — enqueue skips when present); (c) tests for both + real-DB re-run | 1A–1D | no provider call outlives its timeout; duplicate enqueues cannot create concurrent investigations for one exception; transient job failure retries per policy then dead-letters; 485+ tests green; all six real-DB suites green; no behavior change to proposals/policy |
| **2C** | Error taxonomy (`RuntimeFailure` union) mapped to existing strings for compatibility; provider `usage` → `InvestigationMetrics`; per-tenant budget enforcement in the tool loop; model-version stamping in reports | 2B | all failure paths emit typed reasons; evaluation reports carry model id + usage; budget exhaustion is a typed FAILED reason; fixtures updated, holdout untouched |
| **2D** | `ReadTool` registry extraction + move `getSimilarPastExceptions` behind an OMS query service; document/rename OMS triage services (P3) | 2C | tool registry invariant test (every tool tenant+store scoped — source-scan spec like `decision-model-safety.spec.ts`); no behavior change |
| **2E** | First second domain (returns or reconciliation) as a **consumer** of the runtime: domain detector → exception category + 2 read tools + 1 adapter | 2D | domain added without touching runtime internals; evaluation corpus gains a domain slice with holdout |

Each phase keeps: no live provider calls in tests, no autonomy expansion, no weakening of authorization/RLS, full suite + tsc + lint + build + real-DB suites as the gate.

---

## 9. Explicitly NOT to build yet

- LangGraph.js / any agent framework; multi-agent topologies.
- Durable workflow engine (Temporal/Inngest/etc.).
- pgvector / embeddings / RAG stores.
- Separate Python AI service or model-serving layer.
- New action types, channels, or shipping providers (Shopify-only channel stays; fake WMS/shipping adapters stay).
- Production Jev wiring or live provider calls in CI; decision-model changes to `83dd34f` artifacts (preservation constraint).
- Autonomy expansion (no new auto-executable actions, no widened policies).
- A generic "connector platform", event-sourcing layer, or CQRS rewrite.
- Dashboard/UI (out of scope until runtime contracts settle).
- Cross-store evidence widening (Phase 1D verdict stands: requires an explicit authorization decision).
- Any replacement of OMS/WMS/ERP state ownership.

---

## 10. Recommendation — smallest safe Phase 2B

**Phase 2B = "Reliable runtime substrate": provider cancellation + investigation-job lifecycle contract.** Two verified S1 defects (P1, P2), no new capability, no schema migration (the dedupe rule uses existing `AiInvestigation.status=RUNNING`), no new dependencies (AbortController is stdlib; BullMQ already supports attempts/backoff/dead-letter config):

1. `GroqLlmClient`: clamped timeout + `AbortSignal` (mirroring `jev-decision-model.client.ts` semantics); thread the signal from `investigate()`'s cancellation through `runToolLoop` so a cancelled/timed-out run also cancels provider I/O (closing the Phase 1B honesty gap truthfully).
2. `AiInvestigationQueueModule`: explicit retry/backoff/dead-letter (matching `queue.module.ts` conventions) + enqueue-time and worker-time idempotency (`EXISTS RUNNING investigation for (tenantId, storeId, exceptionId)` → skip), with an audited skip event.
3. Regression tests: abort mid-call, timeout ≤ configured clamp, duplicate-enqueue coalescing, retry-then-dead-letter path; re-run all six real-DB suites.

Done when: no provider call outlives its run; one exception never has two concurrent investigations; transient failures recover per policy; everything green; nothing else changed.
