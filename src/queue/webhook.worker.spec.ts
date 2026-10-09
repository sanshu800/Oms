import { beforeEach, describe, expect, it, vi } from "vitest";

import { WebhookWorker } from "./webhook.worker";

describe("WebhookWorker", () => {
  let worker: WebhookWorker;

  const webhookProcessor = {
    processEvent: vi.fn(),
  };

  const wmsEventProcessor = {
    processEvent: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();

    worker = new WebhookWorker(webhookProcessor as any, wmsEventProcessor as any);
  });

  it("should pass the BullMQ attempt number to the processor", async () => {
    const job = {
      id: "job-1",
      name: "process-webhook",
      data: {
        webhookEventId: "event-1",
      },
      attemptsMade: 2,
      opts: {
        attempts: 5,
      },
    } as any;

    await worker.process(job);

    expect(webhookProcessor.processEvent).toHaveBeenCalledWith("event-1", {
      attempt: 3,
      maxAttempts: 5,
    });
  });

  it("should propagate processor errors to BullMQ", async () => {
    webhookProcessor.processEvent.mockRejectedValue(
      new Error("temporary failure"),
    );

    const job = {
      id: "job-2",
      name: "process-webhook",
      data: {
        webhookEventId: "event-2",
      },
      attemptsMade: 0,
      opts: {
        attempts: 5,
      },
    } as any;

    await expect(worker.process(job)).rejects.toThrow("temporary failure");
  });

  it("should ignore unknown job types", async () => {
    const job = {
      id: "job-3",
      name: "unknown-job",
      data: {
        webhookEventId: "event-3",
      },
      attemptsMade: 0,
      opts: {
        attempts: 5,
      },
    } as any;

    await worker.process(job);

    expect(webhookProcessor.processEvent).not.toHaveBeenCalled();
  });
});
