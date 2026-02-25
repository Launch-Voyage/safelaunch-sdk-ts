import type { GuardrailConfig } from "./types.js";
export type { GuardrailConfig, SdkEvent, SdkEventType } from "./types.js";
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
export declare function guardrail(config: GuardrailConfig): (req: {
    ip?: string;
    socket?: {
        remoteAddress?: string;
    };
    headers: Record<string, string | string[] | undefined>;
    method?: string;
    path?: string;
    url?: string;
}, res: {
    statusCode: number;
    status: (code: number) => {
        json: (body: unknown) => void;
    };
    end: (...args: unknown[]) => unknown;
}, next: () => void) => void;
