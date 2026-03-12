import { EventCollector } from "./collector.js";
import type { GuardrailConfig, ResolvedConfig } from "./types.js";

export type { GuardrailConfig, SdkEvent, SdkEventType } from "./types.js";

const DEFAULT_API_URL = "https://guardrail-seven.vercel.app";
const DEFAULT_FLUSH_INTERVAL_MS = 30_000;
const DEFAULT_MAX_BATCH_SIZE = 50;
const DEFAULT_MAX_QUEUE_SIZE = 1000;

/** Auth endpoint patterns */
const AUTH_PATTERNS = [
  /\/login/i,
  /\/signin/i,
  /\/sign-in/i,
  /\/auth/i,
  /\/api\/auth/i,
  /\/api\/login/i,
  /\/session/i,
];

function isAuthEndpoint(path: string): boolean {
  return AUTH_PATTERNS.some((p) => p.test(path));
}

function resolveConfig(config: GuardrailConfig): ResolvedConfig {
  const key = config.apiKey || config.projectKey || "";
  return {
    key,
    project: config.apiKey ? config.project : undefined,
    apiUrl: config.apiUrl || DEFAULT_API_URL,
    flushIntervalMs: config.flushIntervalMs || DEFAULT_FLUSH_INTERVAL_MS,
    maxBatchSize: config.maxBatchSize || DEFAULT_MAX_BATCH_SIZE,
    maxQueueSize: config.maxQueueSize || DEFAULT_MAX_QUEUE_SIZE,
    debug: config.debug || false,
  };
}

/**
 * Express/Connect middleware for GuardRail runtime monitoring.
 *
 * Usage:
 * ```ts
 * import { guardrail } from 'guardrail-sdk'
 *
 * app.use(guardrail({
 *   apiKey: process.env.GUARDRAIL_API_KEY,
 *   project: 'my-app',
 * }))
 * ```
 */
export function guardrail(config: GuardrailConfig) {
  if (!config.apiKey && !config.projectKey) {
    console.error(
      "[guardrail-sdk] Missing apiKey. Set GUARDRAIL_API_KEY environment variable."
    );
    // Return no-op middleware
    return function guardrailNoOp(
      _req: unknown,
      _res: unknown,
      next: () => void
    ) {
      next();
    };
  }

  const resolved = resolveConfig(config);
  const collector = new EventCollector(resolved);

  if (resolved.debug) {
    console.error("[guardrail-sdk] Initialized with Express middleware");
  }

  // Express middleware signature
  return function guardrailMiddleware(
    req: {
      ip?: string;
      socket?: { remoteAddress?: string };
      headers: Record<string, string | string[] | undefined>;
      method?: string;
      path?: string;
      url?: string;
    },
    res: {
      statusCode: number;
      status: (code: number) => { json: (body: unknown) => void };
      end: (...args: unknown[]) => unknown;
    },
    next: () => void
  ) {
    const ip = req.ip || req.socket?.remoteAddress || "";
    const userAgent = (req.headers["user-agent"] as string) || "";
    const path = req.path || req.url || "";
    const now = new Date().toISOString();

    // Block denied IPs
    if (collector.isBlocked(ip)) {
      res.status(403).json({ error: "Access denied" });
      return;
    }

    // Track auth endpoint responses
    if (isAuthEndpoint(path) && req.method === "POST") {
      const origEnd = res.end;
      res.end = function (...args: unknown[]) {
        const status = res.statusCode;
        if (status === 401 || status === 403) {
          collector.push({
            type: "auth.login_failed",
            timestamp: now,
            ip,
            userAgent,
            metadata: { path, method: req.method },
          });
        } else if (status >= 200 && status < 300) {
          collector.push({
            type: "auth.login_success",
            timestamp: now,
            ip,
            userAgent,
            metadata: { path, method: req.method },
          });
        }
        return origEnd.apply(res, args);
      } as typeof res.end;
    }

    // Track all API requests
    collector.push({
      type: "api.request",
      timestamp: now,
      ip,
      userAgent,
      metadata: { path, method: req.method },
    });

    next();
  };
}
