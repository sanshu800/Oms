import { Inject, Injectable } from "@nestjs/common";

import { PrismaService } from "../../prisma/prisma.service";
import {
  ACTION_ADAPTERS,
  ActionAdapter,
  ActionAdapterInput,
  ActionAdapterResult,
} from "./action-adapter.interface";

/**
 * Picks the right ActionAdapter for a store's platform and delegates.
 * Adding a second platform later (Amazon, etc.) means writing a new
 * ActionAdapter and registering it — this service and every caller
 * of it stay unchanged.
 */
@Injectable()
export class AiActuationService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(ACTION_ADAPTERS) private readonly adapters: ActionAdapter[],
  ) {}

  async execute(input: ActionAdapterInput): Promise<ActionAdapterResult> {
    const adapter = await this.resolveAdapter(input);

    if (!adapter) {
      return {
        success: false,
        raw: {
          error: `No action adapter available for actionType ${input.actionType} on this store's platform`,
        },
      };
    }

    return adapter.execute(input);
  }

  async verify(input: ActionAdapterInput): Promise<boolean> {
    const adapter = await this.resolveAdapter(input);

    if (!adapter) {
      return false;
    }

    return adapter.verify(input);
  }

  private async resolveAdapter(
    input: ActionAdapterInput,
  ): Promise<ActionAdapter | null> {
    const store = await this.prisma.storeConnection.findFirst({
      where: { id: input.storeId, tenantId: input.tenantId },
      select: { platform: true },
    });

    if (!store) {
      return null;
    }

    return (
      this.adapters.find(
        (adapter) =>
          adapter.platform === store.platform &&
          adapter.supports(input.actionType),
      ) ?? null
    );
  }
}
