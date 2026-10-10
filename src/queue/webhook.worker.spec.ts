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

  const shippingEventProcessor = {
    processEvent: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();

    worker = new WebhookWorker(
      webhookProcessor as any,
      wmsEventProcessor as any,
      shippingEventProcessor as any,
    );
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
    expect(wmsEventProcessor.processEvent).not.toHaveBeenCalled();
    expect(shippingEventProcessor.processEvent).not.toHaveBeenCalled();
  });

  it("should dispatch WMS and shipping jobs by name with attempt numbers", async () => {
    const wmsJob = {
      id: "job-4",
      name: "process-wms-event",
      data: {
        wmsEventId: "wms-event-1",
      },
      attemptsMade: 1,
      opts: {
        attempts: 5,
      },
    } as any;

    await worker.process(wmsJob);

    expect(wmsEventProcessor.processEvent).toHaveBeenCalledWith(
      "wms-event-1",
      { attempt: 2, maxAttempts: 5 },
    );

    const shippingJob = {
      id: "job-5",
      name: "process-shipping-event",
      data: {
        shippingEventId: "shipping-event-1",
      },
      attemptsMade: 0,
      opts: {
        attempts: 5,
      },
    } as any;

    await worker.process(shippingJob);

    expect(shippingEventProcessor.processEvent).toHaveBeenCalledWith(
      "shipping-event-1",
      { attempt: 1, maxAttempts: 5 },
    );

    expect(webhookProcessor.processEvent).not.toHaveBeenCalled();
  });
});
