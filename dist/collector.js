/**
 * Collects SDK events in-memory and sends them in batches to the GuardRail API.
 * Also tracks blocked IPs returned by the server.
 */
export class EventCollector {
    config;
    queue = [];
    blockedIps = new Set();
    timer = null;
    flushing = false;
    constructor(config) {
        this.config = config;
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
    push(event) {
        this.queue.push(event);
        if (this.queue.length >= this.config.maxBatchSize) {
            void this.flush();
        }
    }
    /** Check if an IP is in the blocked list. */
    isBlocked(ip) {
        return this.blockedIps.has(ip);
    }
    /** Send queued events to the GuardRail API. */
    async flush() {
        if (this.flushing || this.queue.length === 0)
            return;
        this.flushing = true;
        const batch = this.queue.splice(0, this.config.maxBatchSize);
        try {
            const res = await fetch(`${this.config.apiUrl}/api/events`, {
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
                const data = (await res.json());
                // Update blocked IPs from server response
                if (data.blockedIps && Array.isArray(data.blockedIps)) {
                    for (const entry of data.blockedIps) {
                        this.blockedIps.add(entry.ip);
                    }
                }
                if (this.config.debug) {
                    console.error(`[guardrail-sdk] Flushed ${batch.length} events. Blocked IPs: ${this.blockedIps.size}`);
                }
            }
            else {
                // API error — put events back in queue for retry
                this.queue.unshift(...batch);
                if (this.config.debug) {
                    console.error(`[guardrail-sdk] Flush failed (${res.status}). ${batch.length} events re-queued.`);
                }
            }
        }
        catch (err) {
            // Network error — put events back in queue for retry
            this.queue.unshift(...batch);
            if (this.config.debug) {
                console.error(`[guardrail-sdk] Flush error: ${err instanceof Error ? err.message : "Unknown error"}. ${batch.length} events re-queued.`);
            }
        }
        finally {
            this.flushing = false;
        }
    }
    /** Stop the collector and flush remaining events. */
    async destroy() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        await this.flush();
    }
}
