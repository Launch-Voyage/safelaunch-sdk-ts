import type { SdkEvent, ResolvedConfig } from "./types.js";
/**
 * Collects SDK events in-memory and sends them in batches to the GuardRail API.
 * Also tracks blocked IPs returned by the server.
 */
export declare class EventCollector {
    private config;
    private queue;
    private blockedIps;
    private timer;
    private flushing;
    constructor(config: ResolvedConfig);
    /** Add an event to the queue. Triggers immediate flush if batch is full. */
    push(event: SdkEvent): void;
    /** Check if an IP is in the blocked list. */
    isBlocked(ip: string): boolean;
    /** Send queued events to the GuardRail API. */
    flush(): Promise<void>;
    /** Stop the collector and flush remaining events. */
    destroy(): Promise<void>;
}
