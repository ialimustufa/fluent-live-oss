import path from 'node:path';

const MIN_PRODUCTION_ADMIN_SECRET_LENGTH = 16;
const DEFAULT_PORT = 3000;
const DEFAULT_MAX_VIEWERS_PER_SESSION = 500;

export interface Env {
  GEMINI_API_KEY: string;
  ADMIN_SECRET: string;
  DATABASE_PATH: string;
  UPLOADS_DIR: string;
  PORT: number;
  HOST: string;
  PUBLIC_ORIGIN: string | null;
  TRUST_PROXY: boolean;
  /** Concurrent-viewer cap per session; Infinity = unlimited. */
  MAX_VIEWERS_PER_SESSION: number;
  /** Per-IP ceiling for public session/language/poll reads. */
  PUBLIC_GET_MAX: number;
  /** Optional Sentry DSN; error reporting is enabled only when set. */
  SENTRY_DSN: string | null;
  /** Enables test-only control hooks (e.g. kill_gemini_test). Off in production. */
  ENABLE_TEST_HOOKS: boolean;
  /** Emits optional audio/caption timing metadata and audio.marker messages. */
  AUDIO_SYNC_METADATA: boolean;
  /** Operator switch for translated viewer audio. Captions/slides still work when false. */
  AUDIO_SUBSCRIPTION_ACTIVE: boolean;
  /** Cloudflare Realtime SFU config for viewer audio fanout. Required only when audio is active. */
  CF_REALTIME_APP_ID: string | null;
  /** Normalized Cloudflare Realtime SFU app secret. CF_REALTIME_APP_TOKEN remains a compatibility alias. */
  CF_REALTIME_APP_SECRET: string | null;
  CF_REALTIME_API_BASE: string;
  /** R2/CDN config. If incomplete, uploaded PDFs stay on local disk. */
  R2_ACCOUNT_ID: string | null;
  R2_ACCESS_KEY_ID: string | null;
  R2_SECRET_ACCESS_KEY: string | null;
  R2_BUCKET: string | null;
  R2_PUBLIC_BASE_URL: string | null;
  /** Every current/historical public bucket base that must be purged after deletion. */
  R2_CACHE_PURGE_BASE_URLS: string[];
  /** Cloudflare zone/token used to purge directly served PDFs after deletion. */
  R2_CACHE_PURGE_ZONE_ID: string | null;
  R2_CACHE_PURGE_API_TOKEN: string | null;
  ASSET_CDN_BASE_URL: string | null;
}

function parsePort(raw: string | undefined): number {
  const value = raw?.trim() || String(DEFAULT_PORT);
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('PORT must be an integer between 1 and 65535.');
  }
  return port;
}

/** Positive integer, or `0`/empty → Infinity (explicit "no cap" opt-out). */
function parseViewerCap(raw: string | undefined): number {
  const value = raw?.trim() ?? '';
  if (value === '') return DEFAULT_MAX_VIEWERS_PER_SESSION;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error('MAX_VIEWERS_PER_SESSION must be a non-negative integer (0 = unlimited).');
  }
  return n === 0 ? Infinity : n;
}

function parsePositiveInt(raw: string | undefined, fallback: number, name: string): number {
  const value = raw?.trim() ?? '';
  if (!value) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return n;
}

function parseBool(raw: string | undefined): boolean {
  return ['1', 'true', 'yes'].includes((raw ?? '').trim().toLowerCase());
}

function cleanOptional(raw: string | undefined): string | null {
  const value = raw?.trim() ?? '';
  return value || null;
}

function cleanOptionalAppSecret(raw: string | undefined, name: string): string | null {
  let value = cleanOptional(raw);
  if (!value) return null;

  const authorization = /^Authorization\s*:\s*(.+)$/i.exec(value);
  if (authorization) value = authorization[1].trim();

  const bearer = /^Bearer\s+(.+)$/i.exec(value);
  if (bearer) value = bearer[1].trim();

  if (!value) return null;
  if (/\s/.test(value)) {
    throw new Error(`${name} must be a single Cloudflare Realtime SFU app secret, without spaces.`);
  }
  return value;
}

function cleanOptionalOrigin(raw: string | undefined, name: string): string | null {
  const value = cleanOptional(raw)?.replace(/\/+$/, '') ?? '';
  if (!value) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('unsupported protocol');
    return url.origin;
  } catch {
    throw new Error(`${name} must be an absolute http(s) origin, for example https://cdn.example.com`);
  }
}

function cleanOptionalUrl(raw: string | undefined, name: string): string | null {
  const value = cleanOptional(raw);
  if (!value) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('unsupported protocol');
    return url.toString().replace(/\/+$/, '');
  } catch {
    throw new Error(`${name} must be an absolute http(s) URL`);
  }
}

function cleanOptionalUrlList(raw: string | undefined, name: string): string[] {
  const values = (raw ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value, index) => cleanOptionalUrl(value, `${name}[${index}]`)!);
  return [...new Set(values)];
}

export function loadEnv(): Env {
  // Auto-load .env if present (native Node, no dotenv dependency). Checks the
  // cwd first, then the parent — workspace scripts run with cwd=server/ while
  // the .env lives at the repo root. Existing shell vars take precedence.
  for (const file of ['.env', '../.env']) {
    try {
      process.loadEnvFile(path.resolve(file));
      break;
    } catch {
      /* not found — try the next location or fall back to the shell env */
    }
  }

  const isProduction = process.env.NODE_ENV === 'production';
  let adminSecret = process.env.ADMIN_SECRET?.trim() ?? '';
  const unsafeAdminSecret = !adminSecret || adminSecret === 'admin' || adminSecret === 'change-me';
  if (isProduction && unsafeAdminSecret) {
    throw new Error('ADMIN_SECRET must be set to a non-placeholder value in production.');
  }
  if (isProduction && adminSecret.length < MIN_PRODUCTION_ADMIN_SECRET_LENGTH) {
    throw new Error(`ADMIN_SECRET must be at least ${MIN_PRODUCTION_ADMIN_SECRET_LENGTH} characters in production.`);
  }
  if (!adminSecret) {
    adminSecret = 'admin';
    console.warn(
      'WARNING: ADMIN_SECRET is not set — defaulting to "admin" for local development only. ' +
        'Set a real secret before exposing this server.'
    );
  } else if (adminSecret === 'admin' || adminSecret === 'change-me') {
    console.warn(
      `WARNING: ADMIN_SECRET is set to the placeholder value "${adminSecret}". ` +
        'Use a long random value before exposing this server.'
    );
  } else if (adminSecret.length < MIN_PRODUCTION_ADMIN_SECRET_LENGTH) {
    console.warn(
      `WARNING: ADMIN_SECRET is shorter than ${MIN_PRODUCTION_ADMIN_SECRET_LENGTH} characters. ` +
        'Use a long random value before exposing this server.'
    );
  }

  const geminiKey = process.env.GEMINI_API_KEY?.trim() ?? '';
  if (isProduction && !geminiKey) {
    throw new Error('GEMINI_API_KEY must be set in production.');
  }
  if (!geminiKey) {
    console.warn(
      'WARNING: GEMINI_API_KEY is not set — sessions will run but live translation will fail to connect.'
    );
  }

  const publicOrigin = cleanOptionalOrigin(process.env.PUBLIC_ORIGIN, 'PUBLIC_ORIGIN');

  const defaultDatabasePath = isProduction ? '/data/app.db' : './data/app.db';
  const defaultUploadsDir = isProduction ? '/data/uploads' : './data/uploads';

  const audioSubscriptionActive = parseBool(process.env.AUDIO_SUBSCRIPTION_ACTIVE);
  const audioSyncMetadata =
    process.env.AUDIO_SYNC_METADATA === undefined
      ? audioSubscriptionActive
      : parseBool(process.env.AUDIO_SYNC_METADATA);
  const cfRealtimeAppId = cleanOptional(process.env.CF_REALTIME_APP_ID);
  const cfRealtimeAppSecret =
    cleanOptionalAppSecret(process.env.CF_REALTIME_APP_SECRET, 'CF_REALTIME_APP_SECRET') ??
    cleanOptionalAppSecret(process.env.CF_REALTIME_APP_TOKEN, 'CF_REALTIME_APP_TOKEN');
  const cfRealtimeApiBase = cleanOptionalUrl(
    process.env.CF_REALTIME_API_BASE ?? 'https://rtc.live.cloudflare.com/v1',
    'CF_REALTIME_API_BASE'
  )!;
  if (isProduction && audioSubscriptionActive) {
    if (!publicOrigin) throw new Error('PUBLIC_ORIGIN is required when AUDIO_SUBSCRIPTION_ACTIVE=true.');
    if (!cfRealtimeAppId || !cfRealtimeAppSecret) {
      throw new Error('CF_REALTIME_APP_ID and CF_REALTIME_APP_SECRET are required when AUDIO_SUBSCRIPTION_ACTIVE=true.');
    }
  }

  const r2PublicBaseUrl = cleanOptionalUrl(process.env.R2_PUBLIC_BASE_URL, 'R2_PUBLIC_BASE_URL');
  const assetCdnBaseUrl = cleanOptionalUrl(process.env.ASSET_CDN_BASE_URL, 'ASSET_CDN_BASE_URL');
  const r2CachePurgeBaseUrls = [
    ...new Set(
      [
        r2PublicBaseUrl,
        ...cleanOptionalUrlList(process.env.R2_CACHE_PURGE_BASE_URLS, 'R2_CACHE_PURGE_BASE_URLS'),
      ].filter((value): value is string => Boolean(value))
    ),
  ];
  if (r2CachePurgeBaseUrls.length > 100) {
    throw new Error('R2_CACHE_PURGE_BASE_URLS supports at most 100 unique public bases.');
  }
  const r2CachePurgeZoneId = cleanOptional(process.env.R2_CACHE_PURGE_ZONE_ID);
  const r2CachePurgeApiToken = cleanOptional(process.env.R2_CACHE_PURGE_API_TOKEN);
  if (Boolean(r2CachePurgeZoneId) !== Boolean(r2CachePurgeApiToken)) {
    throw new Error('R2_CACHE_PURGE_ZONE_ID and R2_CACHE_PURGE_API_TOKEN must be set together.');
  }
  if (r2CachePurgeBaseUrls.length > 0 && (!r2CachePurgeZoneId || !r2CachePurgeApiToken)) {
    throw new Error(
      'R2_CACHE_PURGE_ZONE_ID and R2_CACHE_PURGE_API_TOKEN are required when an R2 slide purge base URL is set.'
    );
  }

  return {
    GEMINI_API_KEY: geminiKey,
    ADMIN_SECRET: adminSecret,
    // @fastify/static and SQLite both want absolute paths; resolve relative
    // values (common in local dev) against the working directory.
    DATABASE_PATH: path.resolve(process.env.DATABASE_PATH ?? defaultDatabasePath),
    UPLOADS_DIR: path.resolve(process.env.UPLOADS_DIR ?? defaultUploadsDir),
    PORT: parsePort(process.env.PORT),
    HOST: process.env.HOST?.trim() || '0.0.0.0',
    PUBLIC_ORIGIN: publicOrigin,
    TRUST_PROXY: parseBool(process.env.TRUST_PROXY),
    MAX_VIEWERS_PER_SESSION: parseViewerCap(process.env.MAX_VIEWERS_PER_SESSION),
    PUBLIC_GET_MAX: parsePositiveInt(process.env.PUBLIC_GET_MAX, 2_000, 'PUBLIC_GET_MAX'),
    SENTRY_DSN: process.env.SENTRY_DSN?.trim() || null,
    // Test hooks must never be live in production, regardless of the flag.
    ENABLE_TEST_HOOKS: !isProduction && parseBool(process.env.ENABLE_TEST_HOOKS),
    AUDIO_SYNC_METADATA: audioSyncMetadata,
    AUDIO_SUBSCRIPTION_ACTIVE: audioSubscriptionActive,
    CF_REALTIME_APP_ID: cfRealtimeAppId,
    CF_REALTIME_APP_SECRET: cfRealtimeAppSecret,
    CF_REALTIME_API_BASE: cfRealtimeApiBase,
    R2_ACCOUNT_ID: cleanOptional(process.env.R2_ACCOUNT_ID),
    R2_ACCESS_KEY_ID: cleanOptional(process.env.R2_ACCESS_KEY_ID),
    R2_SECRET_ACCESS_KEY: cleanOptional(process.env.R2_SECRET_ACCESS_KEY),
    R2_BUCKET: cleanOptional(process.env.R2_BUCKET),
    R2_PUBLIC_BASE_URL: r2PublicBaseUrl,
    R2_CACHE_PURGE_BASE_URLS: r2CachePurgeBaseUrls,
    R2_CACHE_PURGE_ZONE_ID: r2CachePurgeZoneId,
    R2_CACHE_PURGE_API_TOKEN: r2CachePurgeApiToken,
    ASSET_CDN_BASE_URL: assetCdnBaseUrl,
  };
}
