export type SdkEventType =
  | "auth.login_failed"
  | "auth.login_success"
  | "api.request";

/** Pluggable HTTP transport — defaults to global `fetch`. */
export type Transport = (url: string, init: RequestInit) => Promise<Response>;

export interface SdkEvent {
  type: SdkEventType;
  timestamp: string;
  ip: string;
  userAgent: string;
  metadata: Record<string, unknown>;
}

export interface SafeLaunchConfig {
  /** Account API key (gr_ak_...). Preferred over projectKey. */
  apiKey?: string;
  /** Project name — required when using apiKey */
  project?: string;
  /** @deprecated Use apiKey instead. Project key (gr_sk_...) for backward compat. */
  projectKey?: string;
  /** API URL override (default: production API URL used by the SDK when unset) */
  apiUrl?: string;
  /** Batch flush interval in ms (default: 30000) */
  flushIntervalMs?: number;
  /** Max events per batch (default: 50) */
  maxBatchSize?: number;
  /** Max events to hold in queue before dropping oldest (default: 1000) */
  maxQueueSize?: number;
  /** Enable debug logging to stderr (default: false) */
  debug?: boolean;
}

export interface ResolvedConfig {
  /** The resolved auth key (apiKey or projectKey) */
  key: string;
  /** Project name (only set when using apiKey) */
  project?: string;
  apiUrl: string;
  flushIntervalMs: number;
  maxBatchSize: number;
  maxQueueSize: number;
  debug: boolean;
}

export interface BlockedIpEntry {
  ip: string;
  blockedAt: string;
}

export interface FlushResponse {
  received: number;
  dropped: number;
  blockedIps: BlockedIpEntry[];
}
