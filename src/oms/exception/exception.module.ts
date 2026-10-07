import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { AiInvestigationQueueModule } from '../../ai/queue/ai-investigation-queue.module';
import { ExceptionService } from './exception.service';

@Module({
  imports: [PrismaModule, AiInvestigationQueueModule],
  providers: [ExceptionService],
  exports: [ExceptionService],
})
export class ExceptionModule {}