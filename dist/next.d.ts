import type { GuardrailConfig } from "./types.js";
export type { GuardrailConfig, SdkEvent, SdkEventType } from "./types.js";
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
export declare function guardrailMiddleware(config: GuardrailConfig): (request: Request) => Response | null;
