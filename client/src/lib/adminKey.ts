/**
 * Admin key handling (spec §2): sent as `Authorization: Bearer` on admin HTTP
 * requests and as the auth field of the WS hello. Never placed in a URL.
 *
 * Persisted in sessionStorage with a 24h expiry so a single operator tab can
 * survive refreshes, but the key is not kept in long-lived browser storage.
 * Rotating ADMIN_SECRET on the server invalidates it immediately regardless.
 */
const KEY = 'fluent.adminKey';
const TTL_MS = 24 * 60 * 60 * 1000; // 1 day

interface Stored {
  key: string;
  expiresAt: number;
}

function clearLegacyAdminKey(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

export function getAdminKey(): string | null {
  clearLegacyAdminKey();
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as Stored;
    if (!s?.key || typeof s.expiresAt !== 'number' || Date.now() > s.expiresAt) {
      sessionStorage.removeItem(KEY);
      return null;
    }
    return s.key;
  } catch {
    return null;
  }
}

export function setAdminKey(key: string): void {
  clearLegacyAdminKey();
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ key, expiresAt: Date.now() + TTL_MS } satisfies Stored));
  } catch {
    /* storage unavailable (private mode) — key just won't persist */
  }
}

export function clearAdminKey(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
  clearLegacyAdminKey();
}

export async function verifyAdminKey(key: string): Promise<boolean> {
  const res = await fetch('/api/auth/check', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
  });
  return res.ok;
}
