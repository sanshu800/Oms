import { Injectable } from "@nestjs/common";

export type InvestigationDecisionAction =
  | "RELEASE_ORDER_RESERVATION"
  | "MANUAL_INVESTIGATION_REQUIRED";

export type InvestigationDecisionInput = {
  category: string;
  fingerprint: string;
};

export type InvestigationDecision = {
  action: InvestigationDecisionAction;
  safe: boolean;
  reason: string;
};

@Injectable()
export class InvestigationDecisionService {
  decide(input: InvestigationDecisionInput): InvestigationDecision {
    if (
      input.category === "ORDER_INTEGRITY" &&
      (
        input.fingerprint.startsWith(
          "failed-order-with-reservation:",
        ) ||
        input.fingerprint.startsWith(
          "order-active-reservation-after-fulfillment:",
        )
      )
    ) {
      return {
        action: "RELEASE_ORDER_RESERVATION",
        safe: true,
        reason: "Known safe deterministic reservation-release strategy",
      };
    }

    return {
      action: "MANUAL_INVESTIGATION_REQUIRED",
      safe: false,
      reason: "No safe deterministic resolution strategy exists",
    };
  }
}
