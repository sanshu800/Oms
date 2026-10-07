import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";

import { PrismaModule } from "../prisma/prisma.module";
import { AuthModule } from "../auth/auth.module";
import { ExceptionModule } from "../oms/exception/exception.module";
import { AuditModule } from "../oms/audit/audit.module";
import { InventoryModule } from "../oms/inventory/inventory.module";
import { OrderModule } from "../oms/order/order.module";

import { AiToolsService } from "./tools/ai-tools.service";
import { AiInvestigationService } from "./investigation/ai-investigation.service";
import { AiInvestigationController } from "./ai-investigation.controller";
import { AiDecisionService } from "./decision/ai-decision.service";
import { AiDecisionController } from "./ai-decision.controller";
import { AiMemoryService } from "./memory/ai-memory.service";
import { AiAutonomyPolicyService } from "./decision/ai-autonomy-policy.service";
import { AiAutonomyService } from "./decision/ai-autonomy.service";
import { AiAutonomyPolicyController } from "./ai-autonomy-policy.controller";
import { AiActuationService } from "./actuation/ai-actuation.service";
import { ShopifyActionAdapter } from "./actuation/shopify-action.adapter";
import { ACTION_ADAPTERS } from "./actuation/action-adapter.interface";
import { GroqLlmClient } from "./llm/groq-llm.client";
import { LLM_CLIENT } from "./llm/llm-client.interface";
import { AI_INVESTIGATION_QUEUE } from "./queue/ai-investigation.queue";
import { AiInvestigationWorker } from "./queue/ai-investigation.worker";

@Module({
  imports: [
    PrismaModule,
    AuthModule,
    ExceptionModule,
    AuditModule,
    InventoryModule,
    OrderModule,
    BullModule.registerQueue({
      name: AI_INVESTIGATION_QUEUE,
    }),
  ],
  controllers: [
    AiInvestigationController,
    AiDecisionController,
    AiAutonomyPolicyController,
  ],
  providers: [
    AiToolsService,
    AiInvestigationService,
    AiInvestigationWorker,
    AiDecisionService,
    AiMemoryService,
    AiAutonomyPolicyService,
    AiAutonomyService,
    AiActuationService,
    ShopifyActionAdapter,
    {
      provide: ACTION_ADAPTERS,
      useFactory: (shopify: ShopifyActionAdapter) => [shopify],
      inject: [ShopifyActionAdapter],
    },
    {
      provide: LLM_CLIENT,
      useClass: GroqLlmClient,
    },
  ],
  exports: [
    AiInvestigationService,
    AiDecisionService,
    AiMemoryService,
    AiAutonomyPolicyService,
    AiAutonomyService,
    AiActuationService,
  ],
})
export class AiModule {}
