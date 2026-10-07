import { StorePlatform } from "@prisma/client";

/**
 * Platform-agnostic contract for actions that change the merchant's
 * real, external store — not internal OMS rows. The AI decision
 * layer decides an abstract action (e.g. "add a note to this order");
 * an adapter translates that into the real platform-specific API
 * call. The reasoning/decision layer never knows Shopify's (or later
 * Amazon's) request shapes.
 */
export type ActionAdapterInput = {
  tenantId: string;
  /** Internal StoreConnection id, not an external platform id. */
  storeId: string;
  actionType: string;
  targetEntityType: string;
  targetEntityId: string;
  params: Record<string, unknown>;
};

export type ActionAdapterResult = {
  success: boolean;
  /** External id/reference the write produced or touched, if any. */
  externalReference?: string;
  raw?: unknown;
};

export interface ActionAdapter {
  readonly platform: StorePlatform;

  supports(actionType: string): boolean;

  execute(input: ActionAdapterInput): Promise<ActionAdapterResult>;

  /**
   * Independently re-read the real external state and confirm the
   * write actually took effect — never trust execute()'s own return
   * value alone, exactly like the internal execution paths in
   * ResolutionService/AiDecisionService.
   */
  verify(input: ActionAdapterInput): Promise<boolean>;
}

export const ACTION_ADAPTERS = Symbol("ACTION_ADAPTERS");
