/**
 * Per-IP rate limit for the public model endpoint.
 *
 * The endpoint is public and backed by a free-tier provider key, so it needs a
 * cheap guard against a single visitor exhausting the quota. This is a fixed
 * window counter kept in memory, per serverless instance.
 *
 * KNOWN LIMIT (documented, not a bug): on Vercel, in-memory state does not
 * persist across cold starts and is not shared between concurrent instances, so
 * the effective limit is per-instance, not global. For a portfolio demo that is
 * the right trade — a shared store (Redis) would be over-engineering here. See
 * DEV_STATE.md.
 */

const MAX = Number(process.env.RATE_LIMIT_MAX ?? "20");
const WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS ?? "60000");

interface Window {
  count: number;
  resetAt: number;
}

const windows = new Map<string, Window>();

export interface RateResult {
  ok: boolean;
  /** Seconds until the window resets — surfaced to the visitor when blocked. */
  retryAfter: number;
}

/** Count one request from `ip`. Returns whether it is allowed. Disabled when
 *  MAX <= 0 (always allows), so the limiter can be turned off by config. */
export function rateLimit(ip: string): RateResult {
  if (MAX <= 0) return { ok: true, retryAfter: 0 };

  const now = Date.now();
  const w = windows.get(ip);

  if (!w || now >= w.resetAt) {
    windows.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    sweep(now);
    return { ok: true, retryAfter: 0 };
  }

  w.count += 1;
  if (w.count > MAX) {
    return { ok: false, retryAfter: Math.max(1, Math.ceil((w.resetAt - now) / 1000)) };
  }
  return { ok: true, retryAfter: 0 };
}

/** Opportunistic cleanup of expired windows so the map can't grow unbounded. */
function sweep(now: number): void {
  if (windows.size < 512) return;
  for (const [ip, w] of windows) if (now >= w.resetAt) windows.delete(ip);
}

/** Best-effort client IP from proxy headers (Vercel sets x-forwarded-for). */
export function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return req.headers.get("x-real-ip") ?? "unknown";
}
