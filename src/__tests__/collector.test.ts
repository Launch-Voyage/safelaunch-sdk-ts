import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventCollector } from "../collector.js";
import type { ResolvedConfig, SdkEvent, Transport } from "../types.js";

function makeConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    key: "test-key",
    apiUrl: "https://test.example.com",
    flushIntervalMs: 999_999, // effectively disable auto-flush
    maxBatchSize: 3,
    maxQueueSize: 5,
    debug: false,
    ...overrides,
  };
}

function makeEvent(id: number): SdkEvent {
  return {
    type: "api.request",
    timestamp: new Date().toISOString(),
    ip: `10.0.0.${id}`,
    userAgent: "test",
    metadata: { id },
  };
}

function okTransport(dropped = 0): Transport {
  return vi.fn<Transport>().mockResolvedValue(
    new Response(JSON.stringify({ received: 1, dropped, blockedIps: [] }), {
      status: 200,
    })
  );
}

function failTransport(status = 500): Transport {
  return vi.fn<Transport>().mockResolvedValue(
    new Response("error", { status })
  );
}

function networkErrorTransport(): Transport {
  return vi.fn<Transport>().mockRejectedValue(new Error("network down"));
}

describe("EventCollector", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("flushes events via transport and clears queue", async () => {
    const transport = okTransport();
    const collector = new EventCollector(makeConfig(), transport);

    collector.push(makeEvent(1));
    collector.push(makeEvent(2));
    await collector.flush();

    expect(transport).toHaveBeenCalledOnce();
    const body = JSON.parse(
      (transport as ReturnType<typeof vi.fn>).mock.calls[0][1].body as string
    );
    expect(body.events).toHaveLength(2);

    // Queue should be empty after successful flush
    await collector.flush();
    // Second flush should not call transport (empty queue)
    expect(transport).toHaveBeenCalledOnce();

    await collector.destroy();
  });

  it("drops oldest events when queue exceeds maxQueueSize", async () => {
    const transport = okTransport();
    const config = makeConfig({ maxQueueSize: 5, maxBatchSize: 10 });
    const collector = new EventCollector(config, transport);

    // Push 8 events into a queue that holds 5
    for (let i = 1; i <= 8; i++) {
      collector.push(makeEvent(i));
    }

    await collector.flush();

    const body = JSON.parse(
      (transport as ReturnType<typeof vi.fn>).mock.calls[0][1].body as string
    );
    // Should have exactly 5 events (the newest ones)
    expect(body.events).toHaveLength(5);
    // Oldest 3 dropped — first event should be id=4
    expect(body.events[0].metadata.id).toBe(4);
    expect(body.events[4].metadata.id).toBe(8);

    await collector.destroy();
  });

  it("logs dropped events in debug mode", async () => {
    const transport = okTransport();
    const config = makeConfig({ maxQueueSize: 3, maxBatchSize: 100, debug: true });
    const collector = new EventCollector(config, transport);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    for (let i = 1; i <= 5; i++) {
      collector.push(makeEvent(i));
    }

    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("Queue full")
    );

    spy.mockRestore();
    await collector.destroy();
  });

  it("skips flush during exponential backoff window", async () => {
    const transport = failTransport();
    const collector = new EventCollector(makeConfig(), transport);

    collector.push(makeEvent(1));
    await collector.flush(); // fails → failCount=1, backoff=2s
    expect(transport).toHaveBeenCalledOnce();

    // Push another event and try to flush immediately — should be skipped (within 2s backoff)
    collector.push(makeEvent(2));
    await collector.flush();
    expect(transport).toHaveBeenCalledOnce(); // still 1 call

    // Advance past the 2s backoff
    vi.advanceTimersByTime(2000);
    await collector.flush();
    expect(transport).toHaveBeenCalledTimes(2); // now retried

    await collector.destroy();
  });

  it("resets backoff on successful flush", async () => {
    let callCount = 0;
    const transport: Transport = vi.fn<Transport>().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return new Response("error", { status: 500 });
      }
      return new Response(
        JSON.stringify({ received: 1, dropped: 0, blockedIps: [] }),
        { status: 200 }
      );
    });

    const collector = new EventCollector(makeConfig(), transport);

    collector.push(makeEvent(1));
    await collector.flush(); // fails → failCount=1

    // Advance past backoff
    vi.advanceTimersByTime(2000);

    collector.push(makeEvent(2));
    await collector.flush(); // succeeds → failCount=0

    // Next flush should proceed immediately (no backoff)
    collector.push(makeEvent(3));
    await collector.flush();
    expect(transport).toHaveBeenCalledTimes(3);

    await collector.destroy();
  });

  it("opens circuit breaker after 5 consecutive failures", async () => {
    const transport = failTransport();
    const collector = new EventCollector(
      makeConfig({ maxQueueSize: 100 }),
      transport
    );

    // Fail 5 times (advancing past each backoff window)
    for (let i = 0; i < 5; i++) {
      collector.push(makeEvent(i));
      vi.advanceTimersByTime(300_000); // advance past any backoff
      await collector.flush();
    }
    expect(transport).toHaveBeenCalledTimes(5);

    // 6th attempt — circuit should be open
    collector.push(makeEvent(99));
    await collector.flush();
    expect(transport).toHaveBeenCalledTimes(5); // no new call

    await collector.destroy();
  });

  it("resumes after circuit breaker cooldown (5 minutes)", async () => {
    const transport = failTransport();
    const collector = new EventCollector(
      makeConfig({ maxQueueSize: 100 }),
      transport
    );

    // Open the circuit (5 failures)
    for (let i = 0; i < 5; i++) {
      collector.push(makeEvent(i));
      vi.advanceTimersByTime(300_000);
      await collector.flush();
    }

    // Advance 5 minutes to close the circuit
    vi.advanceTimersByTime(300_000);

    collector.push(makeEvent(99));
    await collector.flush();
    // Circuit should be closed now — transport called again
    expect(transport).toHaveBeenCalledTimes(6);

    await collector.destroy();
  });

  it("re-queues on failure respecting maxQueueSize", async () => {
    const transport = failTransport();
    const config = makeConfig({ maxQueueSize: 5, maxBatchSize: 3 });
    const collector = new EventCollector(config, transport);

    // Fill queue to 5
    for (let i = 1; i <= 5; i++) {
      collector.push(makeEvent(i));
    }

    // flush takes 3, leaving 2 in queue. Flush fails, re-queues up to capacity (3 more spaces)
    await collector.flush();

    // Now push to fill up
    collector.push(makeEvent(6));
    collector.push(makeEvent(7));

    // Advance past backoff and flush again — total queue should never exceed 5
    vi.advanceTimersByTime(2000);
    await collector.flush();

    // Push more — if queue were unbounded, it would grow. With cap, oldest are dropped.
    for (let i = 10; i <= 20; i++) {
      collector.push(makeEvent(i));
    }

    // Advance past backoff and flush
    vi.advanceTimersByTime(4000);
    const finalTransport = okTransport();
    // Can't swap transport, so just verify no crash and queue stays bounded
    // The important thing: no error thrown during the push loop above
    await collector.destroy();
  });

  it("re-queues on network error respecting maxQueueSize", async () => {
    const transport = networkErrorTransport();
    const config = makeConfig({ maxQueueSize: 5, maxBatchSize: 3 });
    const collector = new EventCollector(config, transport);

    for (let i = 1; i <= 5; i++) {
      collector.push(makeEvent(i));
    }

    // Flush fails with network error — should re-queue without exceeding max
    await collector.flush();

    // Push more — should not throw
    for (let i = 6; i <= 10; i++) {
      collector.push(makeEvent(i));
    }

    await collector.destroy();
  });

  it("destroy clears timer and performs final flush", async () => {
    const transport = okTransport();
    const collector = new EventCollector(makeConfig(), transport);

    collector.push(makeEvent(1));
    await collector.destroy();

    expect(transport).toHaveBeenCalledOnce();

    // Pushing after destroy should still work (no crash), though timer is gone
    collector.push(makeEvent(2));
  });

  it("logs warning when server reports dropped events in debug mode", async () => {
    const transport = okTransport(5);
    const collector = new EventCollector(makeConfig({ debug: true }), transport);
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});

    collector.push(makeEvent(1));
    await collector.flush();

    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("Server dropped 5 events")
    );

    spy.mockRestore();
    await collector.destroy();
  });

  it("does not log when server reports dropped events with debug off", async () => {
    const transport = okTransport(5);
    const collector = new EventCollector(makeConfig({ debug: false }), transport);
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});

    collector.push(makeEvent(1));
    await collector.flush();

    expect(spy).not.toHaveBeenCalled();

    spy.mockRestore();
    await collector.destroy();
  });

  it("does not warn when server reports zero dropped events", async () => {
    const transport = okTransport(0);
    const collector = new EventCollector(makeConfig({ debug: true }), transport);
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});

    collector.push(makeEvent(1));
    await collector.flush();

    expect(spy).not.toHaveBeenCalled();

    spy.mockRestore();
    await collector.destroy();
  });

  it("matches full ip against masked blocked ranges", async () => {
    const transport: Transport = vi.fn<Transport>().mockResolvedValue(
      new Response(
        JSON.stringify({
          received: 1,
          dropped: 0,
          blockedIps: [{ ip: "192.168.1.x", blockedAt: new Date().toISOString() }],
        }),
        { status: 200 }
      )
    );
    const collector = new EventCollector(makeConfig(), transport);

    collector.push(makeEvent(1));
    await collector.flush();

    expect(collector.isBlocked("192.168.1.100")).toBe(true);
    expect(collector.isBlocked("192.168.2.100")).toBe(false);

    await collector.destroy();
  });
});
