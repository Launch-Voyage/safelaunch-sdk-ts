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
    return this.blockedIps.has(maskIpAddress(ip));
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

        if (data.dropped > 0 && this.config.debug) {
          console.warn(
            `[guardrail-sdk] Server dropped ${data.dropped} events. Consider reducing maxBatchSize.`
          );
        }

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

function maskIpv4(ip: string): string {
  const parts = ip.split(".");
  if (parts.length !== 4) return ip.replace(/\.[^.]*$/, ".x");
  return `${parts[0]}.${parts[1]}.${parts[2]}.x`;
}

function ipv4ToIpv6Hextets(ipv4: string): [string, string] | null {
  const octets = ipv4.split(".");
  if (octets.length !== 4) return null;

  const nums = octets.map((o) => Number(o));
  if (nums.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return null;

  const first = ((nums[0] << 8) | nums[1]).toString(16);
  const second = ((nums[2] << 8) | nums[3]).toString(16);
  return [first, second];
}

function normalizeIpv6(ip: string): string[] | null {
  const hasCompression = ip.includes("::");
  const blocks = ip.split("::");
  if (blocks.length > 2) return null;

  const rawLeft = blocks[0] ? blocks[0].split(":").filter(Boolean) : [];
  const rawRight =
    blocks.length === 2 && blocks[1]
      ? blocks[1].split(":").filter(Boolean)
      : [];

  const left = [...rawLeft];
  const right = [...rawRight];

  const convertEmbeddedIpv4 = (side: string[]) => {
    const last = side[side.length - 1];
    if (!last || !last.includes(".")) return true;

    const converted = ipv4ToIpv6Hextets(last);
    if (!converted) return false;

    side.splice(side.length - 1, 1, converted[0], converted[1]);
    return true;
  };

  if (!convertEmbeddedIpv4(left)) return null;
  if (!convertEmbeddedIpv4(right)) return null;

  const total = left.length + right.length;
  if (!hasCompression && total !== 8) return null;
  if (hasCompression && total >= 8) return null;

  const fillCount = hasCompression ? 8 - total : 0;
  return [...left, ...new Array(fillCount).fill("0"), ...right];
}

function maskIpv6(ip: string): string {
  const withoutZone = ip.split("%")[0];
  const normalized = normalizeIpv6(withoutZone);
  if (!normalized) {
    return withoutZone.replace(/:[^:]*$/, ":x");
  }

  normalized[normalized.length - 1] = "x";
  return normalized.join(":");
}

function maskIpAddress(ip: string): string {
  const value = ip.trim();
  if (!value) return "x";

  if (value.includes(":")) {
    return maskIpv6(value);
  }

  if (value.includes(".")) {
    return maskIpv4(value);
  }

  return "x";
}
