/**
 * Trial host token storage (per slug, per tab). The creator of a /try or
 * /beta session uses this token to authenticate the host console instead of the admin secret.
 * Kept in sessionStorage — it's ephemeral and scoped to the creator's tab.
 */
const prefix = 'fluent.trialHost.';

export function setTrialHostToken(slug: string, token: string): void {
  try {
    sessionStorage.setItem(prefix + slug, token);
  } catch {
    /* storage unavailable */
  }
}

export function getTrialHostToken(slug: string): string | null {
  try {
    return sessionStorage.getItem(prefix + slug);
  } catch {
    return null;
  }
}
