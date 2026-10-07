import { Injectable } from "@nestjs/common";
import { AuditActorType, ExceptionStatus, Prisma } from "@prisma/client";

import { PrismaService } from "../../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { ExceptionService } from "../exception/exception.service";
import { InventoryService } from "../inventory/inventory.service";
import { InvestigationDecisionService } from "../investigation/investigation-decision.service";

export type ResolutionContext = {
  tenantId: string;
  storeId: string;
};

export type ResolutionAction =
  "RELEASE_ORDER_RESERVATION" | "MANUAL_INVESTIGATION_REQUIRED";

export type ResolutionResult = {
  exceptionId: string;
  action: ResolutionAction;
  executed: boolean;
  verified: boolean;
  resolved: boolean;
  reason?: string;
};

@Injectable()
export class ResolutionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly exceptionService: ExceptionService,
    private readonly inventoryService: InventoryService,
    private readonly auditService: AuditService,
    private readonly investigationDecisionService: InvestigationDecisionService,
  ) {}

  /**
   * Claim one operational exception for human/AI investigation.
   *
   * Claiming changes lifecycle state only after the exception is
   * verified inside the tenant/store boundary. Attribution is
   * persisted through the audit trail.
   */
  async claim(
    input: ResolutionContext & {
      exceptionId: string;
      actorType: AuditActorType;
      actorId?: string;
    },
  ) {
    const exception = await this.exceptionService.getById({
      tenantId: input.tenantId,
      storeId: input.storeId,
      exceptionId: input.exceptionId,
    });

    if (!exception) {
      throw new Error(`Operational exception not found: ${input.exceptionId}`);
    }

    const claimed = await this.exceptionService.claim({
      tenantId: input.tenantId,
      storeId: input.storeId,
      exceptionId: input.exceptionId,
    });

    if (exception.status === ExceptionStatus.INVESTIGATING) {
      return claimed;
    }

    await this.auditService.recordEvent({
      tenantId: input.tenantId,
      storeId: input.storeId,
      action: "EXCEPTION_CLAIMED",
      actorType: input.actorType,
      actorId: input.actorId,
      entityType: "OPERATIONAL_EXCEPTION",
      entityId: exception.id,
      metadata: {
        previousStatus: exception.status,
        newStatus: ExceptionStatus.INVESTIGATING,
      },
    });

    return claimed;
  }
  /**
   * Resolve one operational exception.
   *
   * Resolution is intentionally allowlisted.
   * Unknown or unsafe exception types remain OPEN.
   */
  async resolve(
    input: ResolutionContext & {
      exceptionId: string;
    },
  ): Promise<ResolutionResult> {
    const exception = await this.exceptionService.getById(input);

    if (!exception) {
      throw new Error(`Operational exception not found: ${input.exceptionId}`);
    }

    if (exception.status === ExceptionStatus.RESOLVED) {
      return {
        exceptionId: exception.id,
        action: this.investigationDecisionService.decide(exception).action,
        executed: false,
        verified: true,
        resolved: true,
        reason: "Exception is already resolved",
      };
    }

    if (exception.status !== ExceptionStatus.INVESTIGATING) {
      return {
        exceptionId: exception.id,
        action: this.investigationDecisionService.decide(exception).action,
        executed: false,
        verified: false,
        resolved: false,
        reason: "Exception must be claimed for investigation before resolution",
      };
    }

    const decision = this.investigationDecisionService.decide(exception);
    const action = decision.action;

    if (!decision.safe || action !== "RELEASE_ORDER_RESERVATION") {
      await this.auditService.recordEvent({
        tenantId: input.tenantId,
        storeId: input.storeId,
        action: "EXCEPTION_RESOLUTION_BLOCKED",
        actorType: AuditActorType.SYSTEM,
        entityType: "OPERATIONAL_EXCEPTION",
        entityId: exception.id,
        metadata: {
          reason: decision.reason,
          category: exception.category,
          fingerprint: exception.fingerprint,
          action,
          safe: decision.safe,
        },
      });

      return {
        exceptionId: exception.id,
        action,
        executed: false,
        verified: false,
        resolved: false,
        reason: decision.reason,
      };
    }

    await this.auditService.recordEvent({
      tenantId: input.tenantId,
      storeId: input.storeId,
      action: "EXCEPTION_RESOLUTION_STARTED",
      actorType: AuditActorType.SYSTEM,
      entityType: "OPERATIONAL_EXCEPTION",
      entityId: exception.id,
      metadata: {
        fingerprint: exception.fingerprint,
        category: exception.category,
        action,
      },
    });
    const orderId = this.extractOrderId(exception.evidence);

    if (!orderId) {
      await this.auditService.recordEvent({
        tenantId: input.tenantId,
        storeId: input.storeId,
        action: "EXCEPTION_RESOLUTION_BLOCKED",
        actorType: AuditActorType.SYSTEM,
        entityType: "OPERATIONAL_EXCEPTION",
        entityId: exception.id,
        metadata: {
          reason: "Order ID missing from exception evidence",
          action,
        },
      });

      return {
        exceptionId: exception.id,
        action,
        executed: false,
        verified: false,
        resolved: false,
        reason: "Order ID missing from exception evidence",
      };
    }

    let executionResult: unknown;

    try {
      executionResult = await this.inventoryService.releaseOrder({
        tenantId: input.tenantId,
        storeId: input.storeId,
        orderId,
      });
    } catch (error) {
      await this.auditService.recordEvent({
        tenantId: input.tenantId,
        storeId: input.storeId,
        action: "EXCEPTION_RESOLUTION_FAILED",
        actorType: AuditActorType.SYSTEM,
        entityType: "OPERATIONAL_EXCEPTION",
        entityId: exception.id,
        metadata: {
          action,
          orderId,
          error: error instanceof Error ? error.message : String(error),
        },
      });

      throw error;
    }

    await this.auditService.recordEvent({
      tenantId: input.tenantId,
      storeId: input.storeId,
      action: "EXCEPTION_RESOLUTION_EXECUTED",
      actorType: AuditActorType.SYSTEM,
      entityType: "OPERATIONAL_EXCEPTION",
      entityId: exception.id,
      metadata: {
        action,
        orderId,
        executionResult,
      } as Prisma.InputJsonValue,
    });

    const verification = await this.verifyOrderReservationReleased(
      input,
      orderId,
    );

    if (!verification.verified) {
      await this.auditService.recordEvent({
        tenantId: input.tenantId,
        storeId: input.storeId,
        action: "EXCEPTION_RESOLUTION_VERIFICATION_FAILED",
        actorType: AuditActorType.SYSTEM,
        entityType: "OPERATIONAL_EXCEPTION",
        entityId: exception.id,
        metadata: {
          action,
          orderId,
          activeReservationCount: verification.activeReservationCount,
        },
      });

      return {
        exceptionId: exception.id,
        action,
        executed: true,
        verified: false,
        resolved: false,
        reason: "Resolution executed but active reservation still exists",
      };
    }

    await this.exceptionService.resolve({
      tenantId: input.tenantId,
      storeId: input.storeId,
      exceptionId: exception.id,
    });

    await this.auditService.recordEvent({
      tenantId: input.tenantId,
      storeId: input.storeId,
      action: "EXCEPTION_RESOLVED",
      actorType: AuditActorType.SYSTEM,
      entityType: "OPERATIONAL_EXCEPTION",
      entityId: exception.id,
      metadata: {
        action,
        orderId,
        verified: true,
      },
    });

    return {
      exceptionId: exception.id,
      action,
      executed: true,
      verified: true,
      resolved: true,
    };
  }


  /**
   * Verify the actual operational state after execution.
   *
   * We do not trust InventoryService's return value alone.
   * We verify the persisted state independently.
   */
  private async verifyOrderReservationReleased(
    input: ResolutionContext,
    orderId: string,
  ) {
    const activeReservations = await this.prisma.inventoryReservation.findMany({
      where: {
        tenantId: input.tenantId,
        storeId: input.storeId,
        orderId,
        status: "ACTIVE",
      },
      select: {
        id: true,
      },
    });

    return {
      verified: activeReservations.length === 0,
      activeReservationCount: activeReservations.length,
    };
  }

  private extractOrderId(evidence: unknown): string | null {
    if (
      typeof evidence !== "object" ||
      evidence === null ||
      Array.isArray(evidence)
    ) {
      return null;
    }

    const value = (evidence as Record<string, unknown>).orderId;

    return typeof value === "string" && value.trim() !== "" ? value : null;
  }
}








