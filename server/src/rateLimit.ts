/**
 * rateLimit.ts — tiny in-process fixed-window limiter, the same pattern already
 * used for auth failures (auth.ts) and /try attempts (routes.ts), factored out
 * so HTTP and WS paths can share it. Single-instance only (state lives in a Map,
 * which is fine: the deploy is pinned to one process — see render.yaml).
 */

export interface FixedWindowLimiter {
  /** Record one hit for `key`. Returns false once the window's `max` is exceeded. */
  consume(key: string): boolean;
}

interface Window {
  count: number;
  resetAt: number;
}

export function createFixedWindow(opts: { windowMs: number; max: number }): FixedWindowLimiter {
  const { windowMs, max } = opts;
  const windows = new Map<string, Window>();

  // Periodic sweep so the map cannot grow unboundedly with one-off keys.
  setInterval(() => {
    const now = Date.now();
    for (const [key, w] of windows) {
      if (now > w.resetAt) windows.delete(key);
    }
  }, windowMs).unref();

  return {
    consume(key: string): boolean {
      const now = Date.now();
      const w = windows.get(key);
      if (!w || now > w.resetAt) {
        windows.set(key, { count: 1, resetAt: now + windowMs });
        return true;
      }
      if (w.count >= max) return false;
      w.count += 1;
      return true;
    },
  };
}
