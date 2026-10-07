/**
 * Synthetic actorId used whenever an AiAutonomyPolicy auto-executes a
 * proposal instead of a human. Kept in its own file (not inside
 * ai-decision.service.ts) so ai-memory.service.ts, ai-autonomy.service.ts,
 * and ai-autonomy-policy.service.ts can all reference it without any
 * of them having to import ai-decision.service.ts back, which already
 * imports ai-memory.service.ts — avoids a circular import.
 */
export const AUTONOMY_ACTOR_ID = "ai-autonomy-policy";
