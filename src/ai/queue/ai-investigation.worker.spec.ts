import { describe, expect, it, vi } from "vitest";

import { AiInvestigationWorker } from "./ai-investigation.worker";
import {
  AI_INVESTIGATION_JOB,
  AI_RECOVERY_JOB,
  AiInvestigationQueueService,
} from "./ai-investigation.queue";

type Job = {
  id: string;
  name: string;
  data: Record<string, unknown>;
  opts: { attempts?: number };
  attemptsMade: number;
};

function buildWorker(overrides: {
  investigate?: ReturnType<typeof vi.fn>;
  recover?: ReturnType<typeof vi.fn>;
} = {}) {
  const aiInvestigationService = {
    investigate:
      overrides.investigate ??
      vi.fn().mockResolvedValue({
        investigationId: "inv-1",
        status: "COMPLETED",
        proposalId: "proposal-1",
      }),
    recoverAbandonedInvestigations:
      overrides.recover ??
      vi.fn().mockResolvedValue({ scanned: 0, actions: [] }),
  };

  const prisma = {
    runAsTenant: vi.fn(async (_tenantId: string, fn: () => Promise<unknown>) =>
      fn(),
    ),
    runAsSystem: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  };

  const auditService = {
    recordEvent: vi.fn().mockResolvedValue({}),
  };

  const queue = {
    add: vi.fn().mockResolvedValue({}),
  };

  const worker = new AiInvestigationWorker(
    aiInvestigationService as never,
    prisma as never,
    auditService as never,
    queue as never,
  );

  return { worker, aiInvestigationService, prisma, auditService, queue };
}

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: "job-1",
    name: AI_INVESTIGATION_JOB,
    data: {
      tenantId: "tenant-1",
      storeId: "store-1",
      exceptionId: "exception-1",
    },
    opts: { attempts: 5 },
    attemptsMade: 0,
    ...overrides,
  };
}

describe("AiInvestigationWorker reliability contract", () => {
  it("passes takeoverClaim on redelivery and not on first delivery", async () => {
    const investigate = vi.fn().mockResolvedValue({
      investigationId: "inv-1",
      status: "COMPLETED",
      proposalId: "proposal-1",
    });

    const { worker } = buildWorker({ investigate });

    await worker.process(job({ attemptsMade: 0 }) as never);
    expect(investigate).toHaveBeenLastCalledWith(
      expect.objectContaining({ takeoverClaim: false }),
    );

    await worker.process(job({ attemptsMade: 2 }) as never);
    expect(investigate).toHaveBeenLastCalledWith(
      expect.objectContaining({ takeoverClaim: true }),
    );

    // Stall redelivery: attemptsMade stays 0 but attemptsStarted > 1.
    await worker.process(
      job({ attemptsMade: 0, attemptsStarted: 2 } as never) as never,
    );
    expect(investigate).toHaveBeenLastCalledWith(
      expect.objectContaining({ takeoverClaim: true }),
    );

    await worker.process(
      job({ attemptsMade: 0, attemptsStarted: 1 } as never) as never,
    );
    expect(investigate).toHaveBeenLastCalledWith(
      expect.objectContaining({ takeoverClaim: false }),
    );
  });

  it("treats a persisted FAILED investigation as a permanent job outcome", async () => {
    const investigate = vi.fn().mockResolvedValue({
      investigationId: "inv-1",
      status: "FAILED",
      error: "model never corrected its invalid proposals",
    });

    const { worker, auditService } = buildWorker({ investigate });

    // Business failures never throw — the job completes and is not retried.
    await expect(worker.process(job() as never)).resolves.toBeUndefined();
    expect(auditService.recordEvent).not.toHaveBeenCalled();
  });

  it("coalesces a duplicate dispatch onto the active run without failing the job", async () => {
    const investigate = vi.fn().mockResolvedValue({
      investigationId: "inv-1",
      status: "FAILED",
      error: "Investigation timed out",
      attachedToActiveRun: true,
    });

    const { worker, auditService } = buildWorker({ investigate });

    await expect(worker.process(job() as never)).resolves.toBeUndefined();
    expect(auditService.recordEvent).not.toHaveBeenCalled();
  });

  it("rethrows infrastructure failures while attempts remain (retryable)", async () => {
    const investigate = vi
      .fn()
      .mockRejectedValue(new Error("database unreachable"));

    const { worker, auditService } = buildWorker({ investigate });

    await expect(
      worker.process(job({ attemptsMade: 1 }) as never),
    ).rejects.toThrow("database unreachable");

    // Not terminal yet — no exhausted record.
    expect(auditService.recordEvent).not.toHaveBeenCalled();
  });

  it("records durable exhaustion on the final attempt and still rethrows", async () => {
    const investigate = vi
      .fn()
      .mockRejectedValue(new Error("database unreachable"));

    const { worker, auditService } = buildWorker({ investigate });

    // attempts 5 → attemptsMade 4 is the final attempt.
    await expect(
      worker.process(job({ attemptsMade: 4 }) as never),
    ).rejects.toThrow("database unreachable");

    expect(auditService.recordEvent).toHaveBeenCalledTimes(1);
    expect(auditService.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "AI_INVESTIGATION_JOB_EXHAUSTED",
        metadata: expect.objectContaining({
          attempts: 5,
          error: "database unreachable",
        }),
      }),
    );
  });

  it("re-dispatches abandoned runs from the recovery sweep and leaves abandoned ones alone", async () => {
    const recover = vi.fn().mockResolvedValue({
      scanned: 2,
      actions: [
        {
          investigationId: "inv-1",
          tenantId: "tenant-1",
          storeId: "store-1",
          exceptionId: "exception-1",
          action: "redispatch",
          reason: "lease expired",
        },
        {
          investigationId: "inv-2",
          tenantId: "tenant-1",
          storeId: "store-1",
          exceptionId: "exception-2",
          action: "abandoned",
          reason: "abandoned after 2 recovery attempt(s)",
        },
      ],
    });

    const { worker, queue } = buildWorker({ recover });

    await worker.process(job({ name: AI_RECOVERY_JOB, data: {} }) as never);

    expect(recover).toHaveBeenCalledTimes(1);
    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(queue.add).toHaveBeenCalledWith(
      AI_INVESTIGATION_JOB,
      expect.objectContaining({
        tenantId: "tenant-1",
        exceptionId: "exception-1",
        dispatchKey: expect.stringMatching(/^recovery:inv-1-\d+$/),
      }),
      expect.objectContaining({
        attempts: 1,
        jobId: expect.stringMatching(/^investigate:recovery:inv-1-\d+$/),
      }),
    );
  });
});

describe("AiInvestigationQueueService job options", () => {
  function buildQueueService(config: Record<string, unknown>) {
    const queue = { add: vi.fn().mockResolvedValue({}), on: vi.fn() };
    const service = new AiInvestigationQueueService(queue as never, {
      get: (key: string) => config[key],
    } as never);

    return { service, queue };
  }

  it("enforces bounded attempts, exponential backoff, and retained failures", async () => {
    const { service, queue } = buildQueueService({
      AI_INVESTIGATION_JOB_ATTEMPTS: 3,
      AI_INVESTIGATION_JOB_BACKOFF_MS: 2500,
      AI_INVESTIGATION_JOB_REMOVE_ON_FAIL: 250,
    });

    await service.enqueue({
      tenantId: "tenant-1",
      storeId: "store-1",
      exceptionId: "exception-1",
    });

    expect(queue.add).toHaveBeenCalledWith(
      AI_INVESTIGATION_JOB,
      expect.anything(),
      expect.objectContaining({
        attempts: 3,
        backoff: { type: "exponential", delay: 2500 },
        removeOnFail: 250,
      }),
    );
  });

  it("deduplicates the same dispatch via a deterministic jobId", async () => {
    const { service, queue } = buildQueueService({});

    await service.enqueue({
      tenantId: "tenant-1",
      storeId: "store-1",
      exceptionId: "exception-1",
      dispatchKey: "exception-1:1730000000000",
    });

    expect(queue.add).toHaveBeenCalledWith(
      AI_INVESTIGATION_JOB,
      expect.anything(),
      expect.objectContaining({
        jobId: "investigate:exception-1:1730000000000",
        attempts: 5,
        backoff: { type: "exponential", delay: 5000 },
        removeOnFail: 500,
      }),
    );
  });
});
