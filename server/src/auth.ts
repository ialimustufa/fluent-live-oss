import crypto from 'node:crypto';

/**
 * Timing-safe comparison of a presented key against ADMIN_SECRET.
 * Both sides are hashed first so timingSafeEqual always compares
 * equal-length buffers (it throws on length mismatch, and a length-based
 * early return would itself be a timing side channel).
 */
export function checkAdminSecret(presented: string | undefined, secret: string): boolean {
  if (typeof presented !== 'string' || presented.length === 0) return false;
  const a = crypto.createHash('sha256').update(presented).digest();
  const b = crypto.createHash('sha256').update(secret).digest();
  return crypto.timingSafeEqual(a, b);
}

/**
 * Fixed-window rate limiter for failed auth attempts: 5 failures/min per IP.
 * Successful auths do not count against the window.
 */
const WINDOW_MS = 60_000;
const MAX_FAILURES = 5;

interface Window {
  count: number;
  resetAt: number;
}

const failures = new Map<string, Window>();

export function isRateLimited(ip: string): boolean {
  const w = failures.get(ip);
  if (!w) return false;
  if (Date.now() > w.resetAt) {
    failures.delete(ip);
    return false;
  }
  return w.count >= MAX_FAILURES;
}

export function recordAuthFailure(ip: string): void {
  const now = Date.now();
  const w = failures.get(ip);
  if (!w || now > w.resetAt) {
    failures.set(ip, { count: 1, resetAt: now + WINDOW_MS });
  } else {
    w.count += 1;
  }
}

// Periodic sweep so the map does not grow unboundedly.
setInterval(() => {
  const now = Date.now();
  for (const [ip, w] of failures) {
    if (now > w.resetAt) failures.delete(ip);
  }
}, WINDOW_MS).unref();
