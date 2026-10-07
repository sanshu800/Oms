import { z } from "zod";

/**
 * The structured shape the model must produce to conclude an
 * investigation. This is the whole point of the architecture: the
 * model's output is never trusted as free text. It must fit this
 * schema exactly, or the investigation is retried/failed rather than
 * silently accepting prose as a "decision."
 */
/**
 * Executable action types have a fixed, required target shape —
 * enforced here, not just described in the prompt, because a model
 * that names the right action but points it at the wrong entity
 * (e.g. the exception instead of the order) would otherwise look
 * identical to a correct proposal until someone actually approved it.
 */
const REQUIRED_TARGET_ENTITY_TYPE: Record<string, string> = {
  RELEASE_ORDER_RESERVATION: "ORDER",
  ADD_ORDER_NOTE: "ORDER",
};

export const decisionProposalSchema = z
  .object({
    actionType: z.string().min(1),
    targetEntityType: z.string().min(1),
    targetEntityId: z.string().min(1),
    params: z.record(z.string(), z.unknown()).default({}),
    confidence: z.number().min(0).max(1),
    basis: z.enum(["TENANT_HISTORY", "POOLED_PRIOR", "HEURISTIC"]),
    riskTier: z.enum(["LOW", "MEDIUM", "HIGH"]),
    reasoningSummary: z.string().min(1),
    evidenceRefs: z.array(z.string()).default([]),
  })
  .superRefine((value, ctx) => {
    const requiredType = REQUIRED_TARGET_ENTITY_TYPE[value.actionType];

    if (requiredType && value.targetEntityType !== requiredType) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["targetEntityType"],
        message: `actionType ${value.actionType} requires targetEntityType "${requiredType}" (the actual ${requiredType.toLowerCase()}'s id), not "${value.targetEntityType}". Use the id from the order you found via get_exception_context or get_order_detail, not the exception's own id.`,
      });
    }
  });

export type DecisionProposalInput = z.infer<typeof decisionProposalSchema>;

export const SUBMIT_DECISION_PROPOSAL_TOOL = "submit_decision_proposal";

export const submitDecisionProposalToolDefinition = {
  name: SUBMIT_DECISION_PROPOSAL_TOOL,
  description:
    "Submit your final, structured conclusion for this investigation. Call this exactly once, only after you have gathered enough evidence with the other tools. If the evidence is insufficient to recommend a concrete action, set actionType to 'NO_ACTION_INSUFFICIENT_EVIDENCE', targetEntityType/targetEntityId to the exception you investigated, a low confidence, basis 'HEURISTIC', and explain why in reasoningSummary. Never invent facts not supported by tool output.",
  parameters: {
    type: "object",
    properties: {
      actionType: {
        type: "string",
        description:
          "The abstract action being proposed, e.g. RELEASE_ORDER_RESERVATION, ADD_ORDER_NOTE, ESCALATE_TO_HUMAN, NO_ACTION_INSUFFICIENT_EVIDENCE. ADD_ORDER_NOTE writes a real note onto the merchant's actual Shopify order — only propose it when a note genuinely helps a human/ops team understand the order's state (e.g. explaining why it's on hold), and always include params.note with the exact text to write.",
      },
      targetEntityType: {
        type: "string",
        description:
          "The kind of entity the action actually operates on — e.g. ORDER, INVENTORY_ITEM. For RELEASE_ORDER_RESERVATION this MUST be ORDER. Only use OPERATIONAL_EXCEPTION for actions that don't touch any other entity, like NO_ACTION_INSUFFICIENT_EVIDENCE or ESCALATE_TO_HUMAN.",
      },
      targetEntityId: {
        type: "string",
        description:
          "The id of the target entity itself — e.g. for RELEASE_ORDER_RESERVATION, the order's own id (from get_exception_context's order.id or get_order_detail), never the exception's id.",
      },
      params: {
        type: "object",
        description:
          "Any additional structured parameters the action needs. For ADD_ORDER_NOTE, this MUST include a 'note' string field with the exact text to write.",
      },
      confidence: {
        type: "number",
        description: "0 to 1. Must reflect how much real evidence supports this, not how confident the model 'feels'.",
      },
      basis: {
        type: "string",
        enum: ["TENANT_HISTORY", "POOLED_PRIOR", "HEURISTIC"],
        description:
          "TENANT_HISTORY if grounded in this tenant's own observed data, POOLED_PRIOR if using general category knowledge, HEURISTIC if a simple rule of thumb.",
      },
      riskTier: {
        type: "string",
        enum: ["LOW", "MEDIUM", "HIGH"],
        description: "How risky/consequential the proposed action is if wrong.",
      },
      reasoningSummary: {
        type: "string",
        description: "Plain-language explanation for a human reviewer.",
      },
      evidenceRefs: {
        type: "array",
        items: { type: "string" },
        description: "Identifiers of the evidence used (order ids, exception id, tool call references).",
      },
    },
    required: [
      "actionType",
      "targetEntityType",
      "targetEntityId",
      "confidence",
      "basis",
      "riskTier",
      "reasoningSummary",
    ],
  },
};
