import { EventCollector } from "./collector.js";
import type { GuardrailConfig, ResolvedConfig } from "./types.js";

export type { GuardrailConfig, SdkEvent, SdkEventType } from "./types.js";

const DEFAULT_API_URL = "https://guardrail-seven.vercel.app";
const DEFAULT_FLUSH_INTERVAL_MS = 30_000;
const DEFAULT_MAX_BATCH_SIZE = 50;
const DEFAULT_MAX_QUEUE_SIZE = 1000;

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

// Singleton collector (Next.js middleware runs in edge runtime, persists across requests)
let collector: EventCollector | null = null;

function getCollector(config: ResolvedConfig): EventCollector {
  if (!collector) {
    collector = new EventCollector(config);
  }
  return collector;
}

/**
 * Next.js middleware for GuardRail runtime monitoring.
 *
 * Usage in middleware.ts:
 * ```ts
 * import { guardrailMiddleware } from 'guardrail-sdk/next'
 *
 * const guardrail = guardrailMiddleware({
 *   apiKey: process.env.GUARDRAIL_API_KEY!,
 *   project: 'my-app',
 * })
 *
 * export async function middleware(request: Request) {
 *   const blocked = guardrail(request)
 *   if (blocked) return blocked
 * }
 * ```
 *
 * Note: Next.js middleware cannot access response status codes,
 * so auth.login_failed/success events cannot be auto-detected.
 * For auth event tracking, call the GuardRail API directly from
 * your API route handlers.
 */
export function guardrailMiddleware(config: GuardrailConfig) {
  if (!config.apiKey && !config.projectKey) {
    console.error(
      "[guardrail-sdk] Missing apiKey. Set GUARDRAIL_API_KEY environment variable."
    );
    return function guardrailNoOp(): Response | null {
      return null;
    };
  }

  const resolved = resolveConfig(config);

  if (resolved.debug) {
    console.error("[guardrail-sdk] Initialized with Next.js middleware");
  }

  /**
   * Call this function inside your Next.js middleware.
   * Returns a Response if the IP is blocked, or null to continue.
   */
  return function guardrail(request: Request): Response | null {
    const c = getCollector(resolved);

    const ip =
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      request.headers.get("x-real-ip") ||
      "";
    const userAgent = request.headers.get("user-agent") || "";

    let pathname: string;
    try {
      pathname = new URL(request.url).pathname;
    } catch {
      pathname = request.url;
    }

    // Block denied IPs
    if (c.isBlocked(ip)) {
      return new Response(JSON.stringify({ error: "Access denied" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      });
    }

    const now = new Date().toISOString();

    // Track API requests
    c.push({
      type: "api.request",
      timestamp: now,
      ip,
      userAgent,
      metadata: { path: pathname, method: request.method },
    });

    // Track auth endpoints (request-only, since we can't see response status)
    if (isAuthEndpoint(pathname) && request.method === "POST") {
      // We log as a generic auth attempt — the server-side analyzer
      // will use the api.request pattern combined with other signals
      if (resolved.debug) {
        console.error(
          `[guardrail-sdk] Auth endpoint hit: ${pathname} from ${ip}`
        );
      }
    }

    return null; // Continue to next middleware
  };
}
