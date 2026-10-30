# TechMart AI — Phase 2C: Runtime Failure Taxonomy, Usage Accounting & Tenant Budget Governance

**Date:** 2026-10-30 · **Branch:** `arena/017dc6c2-oms` · **Commit:** `d41e750` (code) + this report
**Scope:** runtime failure classification, per-invocation usage capture, versioned cost
computation, DB-backed token budgets with atomic reservation, tenant budget governance.
No new AI frameworks, no Python services, no autonomy expansion, no live provider calls.

---

## 1. Capability enabled (Product Direction Lock)

- **Capability:** every model invocation is classified (stable codes), accounted (tokens,
  latency, cost with versioned pricing), and budget-governed (atomic reservation before the
  call; conservative settlement after), per tenant and per investigation.
- **Why the existing architecture was insufficient:** outcomes were free-text `error`
  strings consumers had to pattern-match (the evaluator literally matched
  `/invalid decision proposal/i`); no usage or cost was recorded anywhere; nothing stopped
  two concurrent investigations (or a retry loop) from consuming unbounded provider tokens.
- **Smallest implementation:** four accounting tables + a closed failure vocabulary + one
  wrapper at the single model-call site in `AiInvestigationService`; the tool loop,
  grounding, approval and autonomy semantics are untouched.
- **Testing without new infrastructure:** real PostgreSQL (already the acceptance arbiter)
  for atomicity/isolation; deterministic doubles for the provider; the pricing config is a
  checked-in JSON file, not a pricing service.

## 2. Changed files & schema decisions

### Schema (migration `20261030150000_ai_runtime_accounting`)

| Object | Decision | Rationale |
| --- | --- | --- |
| `AiModelCall` | One row per **actual invocation attempt** (failed attempts included — they may consume provider tokens). Nullable token counts + `usageSource` enum (`REPORTED`/`ESTIMATED`/`UNKNOWN`). Cost = integer **micros** (`BIGINT`) + `pricingVersion` + `currency` + `costStatus` (`CALCULATED`/`UNKNOWN_PRICING`/`NOT_CALCULABLE`). No prompts/credentials/PII columns. | Honest provenance beats fake precision; integer micros avoid float money; the three cost states separate *unknown pricing* from *unknown usage* — both render as **NULL, never 0**. |
| `AiBudgetLedger` | Append-only reservation/settlement log. `PENDING` → guarded `SETTLED` or `RELEASED`. `reservedTokens`, `actualTokens?`, `uncertain`. | Idempotency by construction: the PENDING→terminal transition is a guarded conditional `updateMany`, so a second settle is a no-op. |
| `AiBudgetCounter` | Per-`(tenantId, periodKind DAY|MONTH, periodKey)` reserved-total row. | The budget atom: reservation = one conditional `UPDATE … SET reservedTokens = reservedTokens + x WHERE reservedTokens <= limit - x`. The database decides winners. |
| `AiTenantBudgetLimit` | Operator-adjustable per-tenant daily/monthly overrides (audited service method, no API surface). `NULL` = configured default. | "Controlled operator-approved adjustment" of budgets; defaults stay in env config. |
| `AiInvestigation.failureCode` | New nullable column alongside the existing `error` text. | Stable machine-readable outcome; `error` text preserved for compatibility. |
| RLS | `ENABLE` + `FORCE` + the standard `tenant_isolation` policy on all four new tables (same formula as `AiInvestigation`, `AiDecisionProposal`, …). | Budget/usage rows are tenant data; the Phase 2/1B rule "do not weaken tenant isolation" extends them automatically. |

### Code

| File | Change |
| --- | --- |
| `src/ai/runtime/runtime-failure.ts` (new) | The taxonomy (§3), `classifyThrownError`, `isRuntimeFailure`, `outcomeCodeForModelCall`. |
| `src/ai/accounting/model-pricing.service.ts` (new) | Versioned pricing (§4). Loads `config/model-pricing.json`; injectable snapshot via `MODEL_PRICING_CONFIG` token. |
| `src/ai/accounting/ai-usage.service.ts` (new) | `recordModelCall` — one honest row per invocation. |
| `src/ai/accounting/ai-budget.service.ts` (new) | `limitsFor` / `reserve` / `settle` / `release` / `settleAbandoned` / `usageSummary` (§5). |
| `config/model-pricing.json` (new) | Pricing **configuration data** (see §4 caveat). |
| `src/ai/investigation/ai-investigation.service.ts` | `callModelAccounted` wrapper at the single model-call site; `failure?` on `InvestigateResult`; `failureCode` persisted by `markFailed`/`failWithoutInvestigationRow`; all terminal outcomes carry a structured code; audit metadata includes `failureCode`. |
| `src/ai/validation/investigation-evaluation.service.ts` | **Decoupled from error strings**: code-first classification via `failureCode`, legacy message matching only as fallback for pre-code rows (§6). |
| `src/ai/llm/{llm-error,llm-client.interface,groq-llm.client,scripted-llm}.ts` | `usageDisposition: "none" \| "unknown"` on `LlmClientError` (was the request provably never dispatched?); `LlmUsage` with provenance on results; Groq maps provider usage → `REPORTED`; the test double labels its numbers `ESTIMATED`. |
| `src/config/environment.ts`, `.env.example` | `AI_INVESTIGATION_MAX_MODEL_CALLS` (24), `AI_INVESTIGATION_TOKEN_LIMIT` (100 000), `AI_BUDGET_RESERVATION_TOKENS` (4 000), `AI_TENANT_DAILY_TOKEN_LIMIT` (2 000 000), `AI_TENANT_MONTHLY_TOKEN_LIMIT` (40 000 000) — safe defaults, all overridable. |

## 3. Runtime failure taxonomy

Closed vocabulary (12 codes) — consumers branch on `failure.code`, never on message text:

`TIMEOUT` · `CANCELLED` · `RATE_LIMITED` · `AUTHENTICATION_FAILED` · `PROVIDER_UNAVAILABLE` ·
`PROVIDER_ERROR` · `INVALID_RESPONSE` · `OUTPUT_VALIDATION_FAILED` · `TOOL_EXECUTION_FAILED` ·
`BUDGET_EXCEEDED` · `INVESTIGATION_CONFLICT` · `INTERNAL_ERROR`

Mapping (provider → taxonomy), with the provider classification preserved in
`failure.providerDetail` (kind, HTTP status, usage disposition — never secrets):

| Source | Code | Retryable (semantic) |
| --- | --- | --- |
| LLM timeout (`LlmClientError kind=timeout`), run-level deadline | `TIMEOUT` | yes |
| AbortSignal / `kind=cancelled` | `CANCELLED` — **never** reported as a provider failure | no |
| HTTP 429 | `RATE_LIMITED` | yes |
| HTTP 401/403 | `AUTHENTICATION_FAILED` | no |
| HTTP 5xx, transport loss | `PROVIDER_UNAVAILABLE` | yes |
| other HTTP 4xx | `PROVIDER_ERROR` | no |
| malformed provider output | `INVALID_RESPONSE` | no |
| repeated invalid/ungrounded proposals | `OUTPUT_VALIDATION_FAILED` | no |
| tool execution failure | `TOOL_EXECUTION_FAILED` | no |
| any budget/call/iteration limit | `BUDGET_EXCEEDED` | **no — recorded permanently, never queue-retried, never an approved action** |

`retryable` describes the failure; the retry **policy** is unchanged from 2B: the queue
worker retries only unrecorded infrastructure failures, and every outcome reached through
the investigation service is recorded (hence terminal). *Semantics preserved:* all existing
`error` strings are unchanged; `InvestigateResult`/`AiInvestigation` gained additive fields.

## 4. Usage & cost model

- **Usage:** `inputTokens`/`outputTokens`/`totalTokens`, each nullable, plus
  `usageSource ∈ {REPORTED, ESTIMATED, UNKNOWN}`. Provider-reported counts are stored
  verbatim (`REPORTED`); the deterministic test double labels its fixed numbers
  `ESTIMATED`; anything absent stays `null`/`UNKNOWN` and is **never invented**. Failed
  attempts get rows too (outcome + classification + latency), so consumption by a call that
  never returned is still attributable.
- **Cost:** `cost = tokens × price` in integer micros, input and output priced separately.
  Every computed cost carries `pricingVersion` + `currency`, so historical rows reproduce
  exactly under their own pricing snapshot (verified in unit tests across two config
  versions). `costStatus`:
  - `CALCULATED` — pricing known and counts known;
  - `UNKNOWN_PRICING` — no price entry → all cost fields **NULL, never zero**;
  - `NOT_CALCULABLE` — pricing known but usage unknown → NULL.
- **Pricing config** (`config/model-pricing.json`): versioned, operator-maintained data —
  **not** provider truth. No prices live in business logic. The seeded entries are
  configuration placeholders that operators must verify against the provider's published
  price list before trusting computed cost figures (stated in the file itself).
- **Three distinct numbers, never conflated:** reported usage ≠ estimated cost ≠ actual
  billing. Usage rows say what the provider (or a double) reported; cost says what the
  config computes from it; actual invoices are external-system-of-record truth.

## 5. Budget semantics

- **Reservation is atomic and precedes the call.** Per period (tenant DAY and MONTH), one
  SQL conditional increment decides winners: `UPDATE … SET reservedTokens = reservedTokens +
  x WHERE reservedTokens <= limit - x`. Under READ COMMITTED the loser's UPDATE re-evaluates
  after the row lock and gets 0 rows → `BudgetExceededError` → persisted `BUDGET_EXCEEDED`.
  Ledger insert + both counter movements share one transaction (a failed month reservation
  rolls the day movement back).
- **Per-investigation governance** is cross-attempt: `usageSummary(investigationId)` counts
  ledger entries and reserved tokens from *previous attempts* of the same investigation, so
  a queue retry cannot restart its budgets (`AI_INVESTIGATION_MAX_MODEL_CALLS`,
  `AI_INVESTIGATION_TOKEN_LIMIT`).
- **Settlement is idempotent and conservative.** The `PENDING → SETTLED` guard moves
  counters by `(accounted − reserved)` exactly once. Unknown usage (timeout, mid-flight
  abort, transport loss) keeps the full reservation and sets `uncertain = true` — **no
  incorrect refunds**. A request that provably never dispatched
  (`usageDisposition = "none"` — pre-dispatch cancellation, 429/4xx rejection) releases the
  reservation fully, also idempotently.
- **Exhaustion stops calls** (the gate is before dispatch), preserves evidence (ledger,
  usage rows, audit with `failureCode`), records a structured permanent `BUDGET_EXCEEDED`
  outcome, and is never retried or converted into an approved action. Operator adjustments
  happen only through `AiTenantBudgetLimit` (audited `updatedBy`).
- **Retry safety:** each attempt creates a *new* reservation against the same counters;
  after exhaustion every further attempt is refused (A9). Settlements are keyed by the
  ledger entry id and guarded, so at-least-once settlement cannot double-move counters (A3).
- **Recovery:** `settleAbandoned` closes reservations orphaned by a crash between call and
  settlement — conservatively (full charge, `uncertain`), idempotently (A6). It runs under
  the system context, matching the 2B recovery sweep convention.

## 6. Evaluation decoupling (compat preserved)

`investigation-evaluation.service.ts` now classifies outcomes **code-first**:

- `schemaValidationFailureObserved` / `schema_validity`: `failureCode ===
  "OUTPUT_VALIDATION_FAILED"` (structured) — with the exact legacy regexes retained as the
  fallback **only for rows recorded before `failureCode` existed**, so existing scripts and
  fixtures behave identically;
- `bounded_tool_calls` explicit-bound branch: `failureCode ∈ {TIMEOUT, BUDGET_EXCEEDED}` —
  again with the legacy `/(tool-call budget|token budget|timed out)/i` fallback.

New unit tests prove both directions: codes classify messages that match **no** legacy
phrase; legacy rows without codes still classify by text; unrelated failures
(`PROVIDER_UNAVAILABLE`) are neither misread as validation failures nor as terminated-at-bound.

## 7. Concurrency evidence (real PostgreSQL)

`ai-runtime-accounting-real-db-test.ts` — 13 scenarios, **13/13 PASS** (run twice; full log
kept in the acceptance run):

| # | Scenario | Result |
| --- | --- | --- |
| A1 | 8 racing reservations, limit fits exactly one | 1 fulfilled, 7 `BudgetExceededError`, counter == 4000 |
| A2 | 2 concurrent reserve→settle lifecycles over one limit | exactly 1 winner, counters == 3000 (no double-spend, no negatives) |
| A3 | settle twice | counters moved once |
| A4 | unknown usage | full reservation kept, `uncertain=true`, counts stay NULL |
| A5 | pre-dispatch release ×2 | full refund once, second call a no-op |
| A6 | interrupted settlement recovery | conservative settle + uncertain; rerun settles 0 |
| A7 | daily/monthly exhaustion + rollover | correct `limitKind`s; fresh period key reopens daily budget |
| A8 | tenant isolation | exhausted tenant A never touches B; RLS hides foreign ledger/counter rows both ways |
| A9 | 3 retries after exhaustion | all refused |
| A10 | two attempts, one investigation | `usageSummary` = {entries: 2, reservedTokens: 3500} |
| A11 | usage rows | REPORTED→CALCULATED(versioned micros), ESTIMATED→UNKNOWN_PRICING(NULLs), UNKNOWN→NOT_CALCULABLE(NULLs); RLS isolation |
| A12 | operator override 1000 vs default 4000 | override enforced; other tenants unaffected |
| A13 | guarded `failureCode` persistence | persisted; stale claim cannot overwrite the terminal state |

**Real bug found and fixed by these tests:** racing `aiBudgetCounter` upserts inside the
reservation transaction poison it (PostgreSQL 25P02 after a unique violation), turning a
legitimate budget loser into an infrastructure error. The counter materialization now runs
outside the transaction with the insert race swallowed (the row existing is exactly the
upsert's intent), and the conditional increment remains the sole arbiter.

## 8. Full verification results (exact)

| Gate | Result |
| --- | --- |
| Unit suite (vitest) | **552/552** in 67 files (was 509/509 — **+43**: taxonomy 10, pricing 5, budget 9, usage 5, accounting integration 10, evaluator decoupling 4) |
| `tsc --noEmit` | clean (exit 0) |
| `npm run lint` (repo gate `eslint "src/**/*.ts"`) | exit 0 — **0 warnings from Phase 2C files**; 4 pre-existing warnings in untouched files remain (`investigation-context.service.spec.ts` ×3, `risk-detector.service.ts` ×1), left alone per the no-unrelated-refactors constraint |
| `npm run build` (nest build) | clean |
| Real-DB accounting suite (new) | **13/13 PASS** (×2 runs) |
| `ai-action-loop-real-db-test.ts` | EXIT 0 |
| `ai-investigation-validation-run.ts` (28-case corpus) | EXIT 0 — all criteria PASS (evaluator changes behavior-preserving on the corpus) |
| `shipping-foundation-real-db-test.ts` | PASS |
| `wms-foundation-real-db-test.ts` | PASS |
| `inventory-truth-real-db-test.ts` | EXIT 0 |
| `order-failure-exception-real-db-test.ts` | PERSISTENCE PASSED |
| `ai-runtime-reliability-real-db-test.ts` (2B, S1–S7) | PASS (regression: claim/resume/recovery semantics unaffected) |
| `ai-queue-redis-integration-test.ts` (2B.1, R1–R10) | PASS ×1 this phase (vs ×3 in 2B.1); Redis 7.2.5 / bullmq 5.81.3 / ioredis 5.11.1 |

Database: real PostgreSQL 16.2 (pgserver-bundled), fresh provision, `migrate deploy` through
`20261030150000`, seed-lab-db, RLS verified present + FORCED on all four new tables.

## 9. Limitations (honest, unverifiable here)

- **Live-provider behavior unverified:** no live Groq or Jev calls were made (standing
  constraint). Real provider usage-reporting accuracy, latency, 429/`retry-after` behavior,
  and whether every failure mode reports usage remain untested against the live service.
  The `usageDisposition` semantics are enforced at our classification layer, keyed to
  provider error classes.
- **Cost figures are only as good as `config/model-pricing.json`.** The checked-in prices
  are operator-maintenance placeholders (stated in the file); computed costs are labeled
  with the pricing version but are **not** claims about actual billing. Invoice truth stays
  in the external provider system of record (Product Direction Lock).
- **Unit-level concurrency tests use a deterministic fake** (with transaction-rollback
  semantics); the real atomicity/isolation guarantees are asserted in the real-PostgreSQL
  suite (A1–A13), which is the authority.
- **Redis suite run once this phase** (it is a 2B.1 regression gate, not a 2C surface);
  multi-process/HA/TLS broker behavior remains unverified as recorded in the 2B.1 report.
- **Single-process accounting:** `settleAbandoned` is exposed and tested but not yet
  scheduled periodically (the 2B recovery sweep is the natural integration point for 2D).
  Budget enforcement is per-region/deployment: a multi-instance deployment shares the same
  PostgreSQL counters (the SQL is instance-agnostic), but cross-region replication lag is
  out of scope.
- **`AI_BUDGET_RESERVATION_TOKENS` is a fixed per-call reservation.** Actual usage above
  the reservation charges the true amount at settlement (a documented over-run allowance);
  enforcement holds for subsequent calls because counters reflect reality.

## 10. Next milestone recommendation (for architectural review)

Stop here per plan ("STOP after Phase 2C for architectural review"). Suggested 2D order:

1. **Recovery-sweep integration for `settleAbandoned`** (tiny — wire into the existing 2B
   sweep; closes the interrupted-settlement gap operationally).
2. **Operator surface for `AiTenantBudgetLimit`** (read + audited update endpoint under the
   existing operator auth pattern — the table and service are already in place).
3. **Dashboard/reporting consumption of `AiModelCall`** (per-tenant usage/cost aggregation
   with the provenance labels surfaced — do NOT average ESTIMATED/UNKNOWN into "cost").
4. Defer: multi-region budget coordination, per-store budgets, provider-side spend caps —
   none are needed while TechMart's volume is single-region.
