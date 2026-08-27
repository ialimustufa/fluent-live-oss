/**
 * Viewer onboarding profile, persisted in localStorage so a returning viewer
 * is never re-prompted. `viewerId` is a stable browser id used server-side to
 * dedupe attendance across reconnects/refreshes.
 */
const KEY = 'fluent.viewerProfile';

export interface ViewerProfile {
  viewerId: string;
  name: string;
  company: string;
}

function newId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `v-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

export function getViewerProfile(): ViewerProfile | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
    if (p && typeof p.viewerId === 'string') {
      return { viewerId: p.viewerId, name: p.name ?? '', company: p.company ?? '' };
    }
  } catch {
    /* ignore corrupt storage */
  }
  return null;
}

/** Save (creating a stable viewerId on first save). Name/company may be empty. */
export function saveViewerProfile(input: { name: string; company: string }): ViewerProfile {
  const existing = getViewerProfile();
  const profile: ViewerProfile = {
    viewerId: existing?.viewerId ?? newId(),
    name: input.name.trim(),
    company: input.company.trim(),
  };
  try {
    localStorage.setItem(KEY, JSON.stringify(profile));
  } catch {
    /* storage may be unavailable (private mode) — proceed in-memory */
  }
  return profile;
}
