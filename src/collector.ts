import type {
  SdkEvent,
  ResolvedConfig,
  FlushResponse,
  BlockedIpEntry,
  Transport,
} from "./types.js";

/**
 * Collects SDK events in-memory and sends them in batches to the GuardRail API.
 * Also tracks blocked IPs returned by the server.
 */
export class EventCollector {
  private queue: SdkEvent[] = [];
  private blockedIps: Set<string> = new Set();
  private timer: ReturnType<typeof setInterval> | null = null;
  private flushing = false;
  private transport: Transport;

  private failCount = 0;
  private lastFailTime = 0;
  private dropCount = 0;

  constructor(private config: ResolvedConfig, transport?: Transport) {
    this.transport = transport ?? fetch;

    // Start periodic flush
    this.timer = setInterval(() => {
      void this.flush();
    }, this.config.flushIntervalMs);

    // Ensure timer doesn't prevent process exit
    if (this.timer && typeof this.timer === "object" && "unref" in this.timer) {
      this.timer.unref();
    }
  }

  /** Add an event to the queue. Triggers immediate flush if batch is full. */
  push(event: SdkEvent): void {
    while (this.queue.length >= this.config.maxQueueSize) {
      this.queue.shift();
      this.dropCount++;
    }

    if (this.dropCount > 0 && this.config.debug) {
      console.error(
        `[guardrail-sdk] Queue full. ${this.dropCount} oldest events dropped.`
      );
    }

    this.queue.push(event);

    if (this.queue.length >= this.config.maxBatchSize) {
      void this.flush();
    }
  }

  /** Check if an IP is in the blocked list. */
  isBlocked(ip: string): boolean {
    return this.blockedIps.has(ip);
  }

  private isCircuitOpen(): boolean {
    return this.failCount >= 5 && Date.now() - this.lastFailTime < 300_000;
  }

  private getBackoffMs(): number {
    return Math.min(1000 * Math.pow(2, this.failCount), 300_000);
  }

  /** Send queued events to the GuardRail API. */
  async flush(): Promise<void> {
    // Circuit breaker: stop flushing after 5 consecutive failures for 5 minutes
    if (this.isCircuitOpen()) {
      if (this.config.debug) {
        const remainingSec = Math.ceil(
          (300_000 - (Date.now() - this.lastFailTime)) / 1000
        );
        console.error(
          `[guardrail-sdk] Circuit open. Skipping flush. Resumes in ~${remainingSec}s.`
        );
      }
      return;
    }

    // Exponential backoff: skip flush if within backoff window
    if (this.failCount > 0) {
      const elapsed = Date.now() - this.lastFailTime;
      if (elapsed < this.getBackoffMs()) {
        return;
      }
    }

    if (this.flushing || this.queue.length === 0) return;

    this.flushing = true;
    const batch = this.queue.splice(0, this.config.maxBatchSize);

    try {
      const res = await this.transport(`${this.config.apiUrl}/api/events`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.key}`,
        },
        body: JSON.stringify({
          events: batch,
          ...(this.config.project ? { project: this.config.project } : {}),
        }),
      });

      if (res.ok) {
        const data = (await res.json()) as FlushResponse;

        // Update blocked IPs from server response
        if (data.blockedIps && Array.isArray(data.blockedIps)) {
          for (const entry of data.blockedIps as BlockedIpEntry[]) {
            this.blockedIps.add(entry.ip);
          }
        }

        this.failCount = 0;
        this.dropCount = 0;

        if (this.config.debug) {
          console.error(
            `[guardrail-sdk] Flushed ${batch.length} events. Blocked IPs: ${this.blockedIps.size}`
          );
        }
      } else {
        // API error — re-queue up to remaining capacity
        this.failCount++;
        this.lastFailTime = Date.now();

        const spaceAvailable = this.config.maxQueueSize - this.queue.length;
        if (spaceAvailable > 0) {
          this.queue.unshift(...batch.slice(0, spaceAvailable));
        }

        if (this.config.debug) {
          console.error(
            `[guardrail-sdk] Flush failed (${res.status}). ${batch.length} events re-queued.`
          );
        }
      }
    } catch (err) {
      // Network error — re-queue up to remaining capacity
      this.failCount++;
      this.lastFailTime = Date.now();

      const spaceAvailable = this.config.maxQueueSize - this.queue.length;
      if (spaceAvailable > 0) {
        this.queue.unshift(...batch.slice(0, spaceAvailable));
      }

      if (this.config.debug) {
        console.error(
          `[guardrail-sdk] Flush error: ${err instanceof Error ? err.message : "Unknown error"}. ${batch.length} events re-queued.`
        );
      }
    } finally {
      this.flushing = false;
    }
  }

  /** Stop the collector and flush remaining events. */
  async destroy(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.flush();
  }
}
