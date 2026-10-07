import { Injectable } from '@nestjs/common';
import { AuditActorType, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async recordEvent(input: {
    tenantId: string;
    storeId: string;
    action: string;
    actorType: AuditActorType;
    actorId?: string;
    entityType: string;
    entityId: string;
    metadata?: Prisma.InputJsonValue;
  }) {
    return this.prisma.auditEvent.create({
      data: {
        tenantId: input.tenantId,
        storeId: input.storeId,
        action: input.action,
        actorType: input.actorType,
        actorId: input.actorId,
        entityType: input.entityType,
        entityId: input.entityId,
        metadata: input.metadata,
      },
    });
  }

  async getEntityHistory(input: {
    tenantId: string;
    storeId: string;
    entityType: string;
    entityId: string;
  }) {
    return this.prisma.auditEvent.findMany({
      where: {
        tenantId: input.tenantId,
        storeId: input.storeId,
        entityType: input.entityType,
        entityId: input.entityId,
      },
      orderBy: {
        occurredAt: 'asc',
      },
    });
  }

  async getTenantHistory(input: {
    tenantId: string;
    storeId: string;
  }) {
    return this.prisma.auditEvent.findMany({
      where: {
        tenantId: input.tenantId,
        storeId: input.storeId,
      },
      orderBy: {
        occurredAt: 'desc',
      },
    });
  }
}