import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";

import {
  AI_INVESTIGATION_QUEUE,
  AiInvestigationQueueService,
} from "./ai-investigation.queue";

/**
 * Standalone producer-side module: exports only the queue service,
 * not the AI investigation logic itself. This lets ExceptionModule
 * depend on "a way to enqueue an investigation" without depending on
 * AiModule (which depends on ExceptionModule) — avoids a cycle.
 */
@Module({
  imports: [
    BullModule.registerQueue({
      name: AI_INVESTIGATION_QUEUE,
    }),
  ],
  providers: [AiInvestigationQueueService],
  exports: [AiInvestigationQueueService],
})
export class AiInvestigationQueueModule {}
