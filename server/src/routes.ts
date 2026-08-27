import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { nanoid } from 'nanoid';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { checkAdminSecret, isRateLimited, recordAuthFailure } from './auth.js';
import { createFixedWindow } from './rateLimit.js';
import {
  createBetaTrialSession,
  createSession,
  getBetaLeadByNormalizedEmail,
  getBetaLeads,
  getSessionBySlug,
  getTranscripts,
  getAttendees,
  getAllSessions,
  getDb,
  updateSessionMeta,
  deleteSession,
  getPollResults,
  getReactionTallies,
  recordBetaLeadDuplicate,
  recordBetaLeadExpedite,
  recordBetaLeadFeedback,
  consumeTrialRateLimit,
  recordTrialAbuseEvent,
} from './db.js';
import { isSupportedLanguage, SUPPORTED_LANGUAGES } from './languages.js';
import { getRoom, deleteRoom, registerTrial, unregisterTrial, getTrial } from './rooms.js';
import { validateGeminiLiveKey } from './gemini-key.js';
import fsp from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import type { Env } from './env.js';
import type { SlideStorage } from './storage.js';
import type { RealtimeAudioFanout, RealtimeSubscribeOptions, SessionDescription } from './realtime-audio.js';

const SLUG_ALPHABET_RE = /^[A-Za-z0-9_-]+$/;
const TRIAL_CREATE_WINDOW_MS = 60_000;
const TRIAL_CREATE_MAX_PER_WINDOW = 5;
const BETA_PDF_MAX_BYTES = 5 * 1024 * 1024;
const BETA_RUNTIME_MS = 2 * 60_000;
const BETA_MAX_VIEWERS = 10;
const TRY_RUNTIME_MS = 15 * 60_000;
const TRY_MAX_VIEWERS = 10;
const BETA_BUDGETS = new Set([
  'Not sure yet',
  'Under $25/hour',
  '$25-$50/hour',
  '$50-$100/hour',
  '$100-$150/hour',
  '$150+/hour',
]);
const DISPOSABLE_EMAIL_DOMAINS = new Set([
  '10minutemail.com',
  'anonaddy.com',
  'burnermail.io',
  'dispostable.com',
  'emailondeck.com',
  'fakeinbox.com',
  'getairmail.com',
  'guerrillamail.com',
  'maildrop.cc',
  'mailinator.com',
  'mailnesia.com',
  'moakt.com',
  'sharklasers.com',
  'temp-mail.org',
  'tempmail.com',
  'tempmailo.com',
  'throwawaymail.com',
  'trashmail.com',
  'yopmail.com',
]);
const PLACEHOLDER_EMAIL_LOCAL_RE =
  /^(test|testing|fake|demo|example|sample|asdf|qwerty|foo|bar|none|unknown|no-reply|noreply)([._-]?\d*)?$/;
// Generous per-IP ceiling for the unauthenticated public reads (session info,
// transcript, polls, languages): high enough not to affect a real viewer
// polling, low enough to stop a scraping/DoS loop.
const PUBLIC_GET_WINDOW_MS = 60_000;
const ATTENDEE_ANALYTICS_LIMIT = 500;

interface TempUpload {
  tmpPath: string;
  relPath: string;
}

interface ParsedSessionForm {
  fields: Record<string, string>;
  slideRef: string;
  slideCount: number | null;
  upload: TempUpload | null;
}

interface ParseSessionFormOptions {
  maxPdfBytes?: number;
}

interface RouteDeps {
  slideStorage: SlideStorage;
  audioFanout: RealtimeAudioFanout;
}

function clientIp(req: FastifyRequest): string {
  return req.ip;
}

function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function keyHashPrefix(value: string): string {
  return sha256Hex(value).slice(0, 16);
}

function auditEmail(value: string | undefined): string {
  return normalizeTextField(value, 254).toLowerCase();
}

function httpUrlOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function requestHost(req: FastifyRequest): string | null {
  const raw = req.headers.host;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    return new URL(`http://${raw.trim()}`).host.toLowerCase();
  } catch {
    return null;
  }
}

function isAppOrigin(req: FastifyRequest, origin: string, env: Env): boolean {
  if (env.PUBLIC_ORIGIN && origin === env.PUBLIC_ORIGIN) return true;
  const host = requestHost(req);
  if (!host) return false;
  try {
    return new URL(origin).host.toLowerCase() === host;
  } catch {
    return false;
  }
}

function parseSlideCount(value: string | undefined): number | null | 'invalid' {
  const raw = value?.trim() ?? '';
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 5000) return 'invalid';
  return n;
}

function normalizeTextField(value: string | undefined, max: number): string {
  return (value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
}

function hasFakeOrDisposableDomain(domain: string): boolean {
  if (DISPOSABLE_EMAIL_DOMAINS.has(domain)) return true;
  if (domain.endsWith('.test') || domain.endsWith('.invalid') || domain.endsWith('.localhost')) return true;
  if (domain === 'localhost' || domain === 'local') return true;
  if (['example.com', 'example.org', 'example.net', 'test.com', 'demo.com', 'fake.com'].includes(domain)) return true;
  return false;
}

function normalizeBetaEmail(rawValue: string | undefined):
  | { ok: true; email: string; normalizedEmail: string }
  | { ok: false; error: string } {
  const raw = (rawValue ?? '').trim().toLowerCase();
  if (!raw || raw.length > 254 || /\s/.test(raw)) {
    return { ok: false, error: 'enter a valid work email address' };
  }
  const at = raw.lastIndexOf('@');
  if (at <= 0 || at !== raw.indexOf('@') || at === raw.length - 1) {
    return { ok: false, error: 'enter a valid work email address' };
  }
  const local = raw.slice(0, at);
  let domain = raw.slice(at + 1);
  if (
    local.length > 64 ||
    !domain.includes('.') ||
    local.startsWith('.') ||
    local.endsWith('.') ||
    local.includes('..') ||
    domain.includes('..')
  ) {
    return { ok: false, error: 'enter a valid work email address' };
  }
  if (!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local) || !/^[a-z0-9.-]+$/.test(domain)) {
    return { ok: false, error: 'enter a valid work email address' };
  }
  if (hasFakeOrDisposableDomain(domain)) {
    return { ok: false, error: 'use a real, non-disposable work email address' };
  }

  let normalizedLocal = local.split('+')[0] ?? '';
  if (domain === 'googlemail.com') domain = 'gmail.com';
  if (domain === 'gmail.com') normalizedLocal = normalizedLocal.replace(/\./g, '');
  if (!normalizedLocal || PLACEHOLDER_EMAIL_LOCAL_RE.test(normalizedLocal)) {
    return { ok: false, error: 'use a real, non-demo email address' };
  }
  return { ok: true, email: raw, normalizedEmail: `${normalizedLocal}@${domain}` };
}

function normalizeBetaLead(fields: Record<string, string>):
  | {
      ok: true;
      lead: {
        normalized_email: string;
        email: string;
        full_name: string;
        company: string;
        budget: string;
      };
    }
  | { ok: false; error: string } {
  const fullName = normalizeTextField(fields.fullName, 120);
  const company = normalizeTextField(fields.company, 120);
  const budget = normalizeTextField(fields.budget, 40);
  if (fullName.length < 2) return { ok: false, error: 'full name is required' };
  const email = normalizeBetaEmail(fields.email);
  if (!email.ok) return { ok: false, error: email.error };
  if (company.length < 2) return { ok: false, error: 'company is required' };
  if (!BETA_BUDGETS.has(budget)) return { ok: false, error: 'choose a valid budget range' };
  return {
    ok: true,
    lead: {
      normalized_email: email.normalizedEmail,
      email: email.email,
      full_name: fullName,
      company,
      budget,
    },
  };
}

export function registerRoutes(app: FastifyInstance, env: Env, deps: RouteDeps): void {
  const { slideStorage, audioFanout } = deps;
  const publicGetLimiter = createFixedWindow({
    windowMs: PUBLIC_GET_WINDOW_MS,
    max: env.PUBLIC_GET_MAX,
  });
  const auditSalt = env.ADMIN_SECRET;

  function auditHash(value: string): string {
    return sha256Hex(`${auditSalt}:${value}`);
  }

  function trialIpHash(req: FastifyRequest): string {
    return auditHash(clientIp(req));
  }

  function recordTrialAudit(req: FastifyRequest, row: {
    flow: 'try' | 'beta';
    allowed: boolean;
    reason: string;
    email?: string;
    normalizedEmail?: string;
    keyHashPrefix?: string;
    sessionSlug?: string | null;
    statusCode?: number | null;
    detail?: string;
  }): void {
    recordTrialAbuseEvent({
      flow: row.flow,
      allowed: row.allowed,
      reason: row.reason,
      ip_hash: trialIpHash(req),
      email: row.email,
      normalized_email: row.normalizedEmail,
      key_hash_prefix: row.keyHashPrefix,
      session_slug: row.sessionSlug,
      status_code: row.statusCode,
      detail: row.detail,
    });
  }

  function consumeTrialCreateLimit(req: FastifyRequest, flow: 'try' | 'beta'): { allowed: boolean; retryAfterSec: number } {
    const limited = consumeTrialRateLimit({
      scope: `trial_create:${flow}:ip`,
      key_hash: trialIpHash(req),
      window_ms: TRIAL_CREATE_WINDOW_MS,
      max: TRIAL_CREATE_MAX_PER_WINDOW,
    });
    return {
      allowed: limited.allowed,
      retryAfterSec: Math.max(1, Math.ceil((limited.resetAtMs - Date.now()) / 1000)),
    };
  }
  /** Admin guard: Bearer token, timing-safe compare, rate-limited failures. */
  function requireAdmin(req: FastifyRequest, reply: FastifyReply): boolean {
    const ip = clientIp(req);
    if (isRateLimited(ip)) {
      reply.code(429).send({ error: 'too many failed auth attempts, try again in a minute' });
      return false;
    }
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : undefined;
    if (!checkAdminSecret(token, env.ADMIN_SECRET)) {
      recordAuthFailure(ip);
      reply.code(401).send({ error: 'unauthorized' });
      return false;
    }
    return true;
  }

  /** Authorize an action on a specific session: the shared admin secret, OR
   *  (for trial sessions) the per-session host token. */
  function authorizeSession(req: FastifyRequest, reply: FastifyReply, slug: string): boolean {
    const ip = clientIp(req);
    if (isRateLimited(ip)) {
      reply.code(429).send({ error: 'too many failed auth attempts, try again in a minute' });
      return false;
    }
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : undefined;
    if (checkAdminSecret(token, env.ADMIN_SECRET)) return true;
    const trial = getTrial(slug);
    if (trial && checkAdminSecret(token, trial.hostToken)) return true;
    recordAuthFailure(ip);
    reply.code(401).send({ error: 'unauthorized' });
    return false;
  }

  /** Per-IP throttle for unauthenticated public reads. Returns false (and sends
   *  429) once the window is exceeded. */
  function allowPublicGet(req: FastifyRequest, reply: FastifyReply): boolean {
    if (publicGetLimiter.consume(clientIp(req))) return true;
    reply.code(429).send({ error: 'too many requests, slow down' });
    return false;
  }

  async function cleanupTempUpload(upload: TempUpload | null): Promise<void> {
    if (!upload) return;
    await fsp.unlink(upload.tmpPath).catch(() => {});
  }

  async function cleanupParsedUpload(parsed: ParsedSessionForm | null): Promise<void> {
    await cleanupTempUpload(parsed?.upload ?? null);
  }

  async function isPdfFile(tmpPath: string): Promise<boolean> {
    const fh = await fsp.open(tmpPath, 'r');
    try {
      const stat = await fh.stat();
      if (stat.size < 32) return false;

      const head = Buffer.alloc(Math.min(1024, stat.size));
      const { bytesRead: headBytes } = await fh.read(head, 0, head.length, 0);
      if (!head.subarray(0, headBytes).toString('latin1').includes('%PDF-')) return false;

      // A PDF can contain arbitrary binary object data, but a structurally
      // usable file still ends with a cross-reference pointer and EOF marker.
      // Header-only files otherwise reach pdf.js and fail later as
      // "Invalid PDF structure" with noisy parser warnings.
      const tailLength = Math.min(8192, stat.size);
      const tail = Buffer.alloc(tailLength);
      const { bytesRead: tailBytes } = await fh.read(tail, 0, tailLength, stat.size - tailLength);
      const tailText = tail.subarray(0, tailBytes).toString('latin1');
      return /startxref\s+\d+/m.test(tailText) && tailText.includes('%%EOF');
    } finally {
      await fh.close();
    }
  }

  async function finalizeParsedUpload(parsed: ParsedSessionForm): Promise<string> {
    if (!parsed.upload) return parsed.slideRef;
    const ref = await slideStorage.uploadPdf(parsed.upload.tmpPath, parsed.upload.relPath);
    parsed.upload = null;
    return ref;
  }

  /**
   * Parse a session form into validated fields and, for PDFs, one non-public
   * temp upload. The caller must finalize or clean up the temp upload.
   */
  async function parseSessionForm(
    req: FastifyRequest,
    reply: FastifyReply,
    opts: ParseSessionFormOptions = {}
  ): Promise<ParsedSessionForm | null> {
    const fields: Record<string, string> = {};
    let upload: TempUpload | null = null;

    if (req.isMultipart()) {
      try {
        for await (const part of req.parts()) {
          if (part.type === 'file') {
            if (upload) {
              part.file.resume();
              await cleanupTempUpload(upload);
              reply.code(400).send({ error: 'only one slide file may be uploaded' });
              return null;
            }
            const ext = path.extname(part.filename || '').toLowerCase();
            if (ext !== '.pdf') {
              part.file.resume();
              reply.code(400).send({ error: 'only .pdf uploads are accepted; HTML decks must use an external URL' });
              return null;
            }
            const key = `${nanoid(12)}.pdf`;
            const tmpPath = path.join(env.UPLOADS_DIR, `.${key}.tmp`);
            await fs.promises.mkdir(env.UPLOADS_DIR, { recursive: true });
            try {
              await pipeline(part.file, fs.createWriteStream(tmpPath));
            } catch {
              await fsp.unlink(tmpPath).catch(() => {});
              reply.code(400).send({ error: 'upload failed' });
              return null;
            }
            if (opts.maxPdfBytes !== undefined) {
              const stat = await fsp.stat(tmpPath).catch(() => null);
              if (!stat || stat.size > opts.maxPdfBytes) {
                await fsp.unlink(tmpPath).catch(() => {});
                reply.code(400).send({ error: 'PDF uploads must be 5 MB or smaller for beta trials' });
                return null;
              }
            }
            if (!(await isPdfFile(tmpPath))) {
              await fsp.unlink(tmpPath).catch(() => {});
              reply.code(400).send({ error: 'uploaded file is not a valid PDF' });
              return null;
            }
            upload = { tmpPath, relPath: key };
          } else {
            fields[part.fieldname] = String(part.value ?? '');
          }
        }
      } catch {
        await cleanupTempUpload(upload);
        reply.code(400).send({ error: 'invalid multipart upload' });
        return null;
      }
    } else {
      Object.assign(fields, (req.body ?? {}) as Record<string, string>);
    }

    const targetLang = (fields.targetLang ?? '').trim();
    const slideType = (fields.slideType ?? '').trim();
    const slideUrl = (fields.slideUrl ?? '').trim();
    if (!isSupportedLanguage(targetLang)) {
      await cleanupTempUpload(upload);
      reply.code(400).send({ error: `unsupported target language: ${targetLang}` });
      return null;
    }
    if (!['pdf', 'gslides', 'html'].includes(slideType)) {
      await cleanupTempUpload(upload);
      reply.code(400).send({ error: 'slideType must be pdf, gslides, or html' });
      return null;
    }
    if (upload && slideType !== 'pdf') {
      await cleanupTempUpload(upload);
      reply.code(400).send({ error: 'file uploads are only accepted for pdf slideType' });
      return null;
    }

    let slideRef: string;
    if (slideType === 'pdf') {
      if (!upload) {
        reply.code(400).send({ error: 'pdf slideType requires a .pdf file upload' });
        return null;
      }
      slideRef = upload.relPath;
    } else if (slideType === 'gslides') {
      if (!/^https:\/\/docs\.google\.com\/presentation\//.test(slideUrl)) {
        reply.code(400).send({ error: 'gslides requires a docs.google.com/presentation URL' });
        return null;
      }
      slideRef = slideUrl;
    } else {
      const origin = httpUrlOrigin(slideUrl);
      if (!origin) {
        reply.code(400).send({ error: 'html requires an external http(s) slideUrl; file uploads are disabled' });
        return null;
      }
      if (isAppOrigin(req, origin, env)) {
        reply.code(400).send({ error: 'html slideUrl must be hosted on an external origin' });
        return null;
      }
      slideRef = slideUrl;
    }
    const slideCount = parseSlideCount(fields.slideCount);
    if (slideCount === 'invalid') {
      await cleanupTempUpload(upload);
      reply.code(400).send({ error: 'slideCount must be an integer between 1 and 5000' });
      return null;
    }
    fields.targetLang = targetLang;
    fields.slideType = slideType;
    fields.slideUrl = slideUrl;
    return { fields, slideRef, slideCount, upload };
  }

  app.get('/healthz', async (_req, reply) => {
    try {
      getDb().prepare('SELECT 1').get();
      await fsp.access(env.UPLOADS_DIR, fs.constants.W_OK);
      return { ok: true };
    } catch {
      reply.code(503).send({ ok: false });
    }
  });

  app.get('/api/languages', async (req, reply) => {
    if (!allowPublicGet(req, reply)) return;
    return SUPPORTED_LANGUAGES;
  });

  async function cleanupTrialSession(slug: string): Promise<void> {
    const removed = deleteSession(slug);
    if (removed) await slideStorage.remove(removed.slide_ref);
  }

  /** Admin key check — lets the client validate the key once on gate entry. */
  app.post('/api/auth/check', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    return { ok: true };
  });

  /** Admin-only: verify Cloudflare Realtime SFU publisher setup end-to-end. */
  app.post('/api/admin/audio/sfu/check', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const body = (req.body ?? {}) as { timeoutMs?: unknown };
    const rawTimeout = body.timeoutMs;
    const timeoutMs =
      typeof rawTimeout === 'number' && Number.isFinite(rawTimeout)
        ? Math.min(15_000, Math.max(500, Math.round(rawTimeout)))
        : undefined;
    return audioFanout.checkSetup({ timeoutMs });
  });

  /**
   * Create a session. multipart/form-data with fields:
   *   title?, targetLang, slideType (pdf|gslides|html), echoTargetLanguage?,
   *   slideUrl? (gslides/html), file? (pdf upload only)
   */
  app.post('/api/sessions', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const parsed = await parseSessionForm(req, reply);
    if (!parsed) return;
    const { fields } = parsed;
    let slideRef = '';

    try {
      slideRef = await finalizeParsedUpload(parsed);
      const slug = nanoid(8);
      const session = createSession({
        slug,
        title: (fields.title ?? '').slice(0, 200),
        target_lang: fields.targetLang,
        slide_type: fields.slideType,
        slide_ref: slideRef,
        slide_count: parsed.slideCount,
        echo_target_language: fields.echoTargetLanguage === 'true',
        presentation_mode: fields.presentationMode === 'remote' ? 'remote' : 'in_person',
      });

      return {
        slug: session.slug,
        viewerPath: `/${session.slug}`,
        hostPath: `/${session.slug}/host`,
      };
    } catch (err) {
      await cleanupParsedUpload(parsed);
      await slideStorage.remove(slideRef);
      throw err;
    }
  });

  /**
   * Self-serve trial (/try): NO admin secret. The visitor supplies their own
   * `geminiApiKey` field, which is kept only in memory (never stored or logged)
   * and used solely for this session's translation. Returns a per-session
   * `hostToken` that the host console uses instead of ADMIN_SECRET. Viewers are
   * capped at 10, and the live trial runtime is capped server-side.
   */
  app.post('/api/try', async (req, reply) => {
    const createLimit = consumeTrialCreateLimit(req, 'try');
    if (!createLimit.allowed) {
      recordTrialAudit(req, {
        flow: 'try',
        allowed: false,
        reason: 'rate_limited_ip',
        statusCode: 429,
      });
      reply.header('Retry-After', String(createLimit.retryAfterSec));
      reply.code(429).send({ error: 'too many trial attempts, try again in a minute' });
      return;
    }
    const parsed = await parseSessionForm(req, reply);
    if (!parsed) {
      recordTrialAudit(req, {
        flow: 'try',
        allowed: false,
        reason: 'invalid_form',
        statusCode: reply.statusCode >= 400 ? reply.statusCode : 400,
      });
      return;
    }
    const { fields } = parsed;

    const geminiKey = (fields.geminiApiKey ?? '').trim();
    const auditKeyHash = geminiKey ? keyHashPrefix(geminiKey) : '';
    const email = auditEmail(fields.email);
    if (geminiKey.length < 8) {
      await cleanupParsedUpload(parsed);
      recordTrialAudit(req, {
        flow: 'try',
        allowed: false,
        reason: 'invalid_key_format',
        email,
        normalizedEmail: email,
        keyHashPrefix: auditKeyHash,
        statusCode: 400,
      });
      reply.code(400).send({ error: 'a Gemini API key is required to start a trial' });
      return;
    }

    if (env.VALIDATE_TRIAL_GEMINI_KEYS) {
      const validation = await validateGeminiLiveKey(
        geminiKey,
        fields.targetLang,
        fields.echoTargetLanguage === 'true'
      );
      if (!validation.ok) {
        await cleanupParsedUpload(parsed);
        const statusCode = validation.reason === 'invalid' ? 400 : 503;
        recordTrialAudit(req, {
          flow: 'try',
          allowed: false,
          reason: validation.reason === 'invalid' ? 'invalid_gemini_key' : 'gemini_validation_failed',
          email,
          normalizedEmail: email,
          keyHashPrefix: auditKeyHash,
          statusCode,
          detail: validation.reason,
        });
        reply.code(statusCode).send({ error: validation.message });
        return;
      }
    }

    const slug = nanoid(8);
    const hostToken = nanoid(32);
    if (!registerTrial(slug, {
      geminiKey,
      hostToken,
      maxViewers: TRY_MAX_VIEWERS,
      ttlMs: env.TRIAL_TTL_MS,
      runtimeMs: TRY_RUNTIME_MS,
      onExpire: cleanupTrialSession,
    })) {
      await cleanupParsedUpload(parsed);
      recordTrialAudit(req, {
        flow: 'try',
        allowed: false,
        reason: 'active_trial_capacity',
        email,
        normalizedEmail: email,
        keyHashPrefix: auditKeyHash,
        statusCode: 503,
      });
      reply.code(503).send({ error: 'too many active trials right now — please try again shortly' });
      return;
    }

    let slideRef = '';
    try {
      slideRef = await finalizeParsedUpload(parsed);
      createSession({
        slug,
        title: (fields.title ?? '').slice(0, 200),
        target_lang: fields.targetLang,
        slide_type: fields.slideType,
        slide_ref: slideRef,
        slide_count: parsed.slideCount,
        echo_target_language: fields.echoTargetLanguage === 'true',
        presentation_mode: fields.presentationMode === 'remote' ? 'remote' : 'in_person',
        is_trial: true,
        trial_type: 'try',
      });
      recordTrialAudit(req, {
        flow: 'try',
        allowed: true,
        reason: 'created',
        email,
        normalizedEmail: email,
        keyHashPrefix: auditKeyHash,
        sessionSlug: slug,
        statusCode: 200,
      });
    } catch (err) {
      unregisterTrial(slug);
      await cleanupParsedUpload(parsed);
      await slideStorage.remove(slideRef);
      recordTrialAudit(req, {
        flow: 'try',
        allowed: false,
        reason: 'server_error',
        email,
        normalizedEmail: email,
        keyHashPrefix: auditKeyHash,
        statusCode: 500,
      });
      throw err;
    }

    return {
      slug,
      hostToken,
      viewerPath: `/${slug}`,
      hostPath: `/${slug}/host`,
    };
  });

  /**
   * Hosted beta trial (/beta): first-party, no user key. Uses the server-side
   * GEMINI_API_KEY, stores lead details durably, and allows one successful
   * beta trial ever per normalized email. The host token is returned only in
   * the JSON body for sessionStorage handoff by the creator.
   */
  app.post('/api/beta/trial', async (req, reply) => {
    const createLimit = consumeTrialCreateLimit(req, 'beta');
    if (!createLimit.allowed) {
      recordTrialAudit(req, {
        flow: 'beta',
        allowed: false,
        reason: 'rate_limited_ip',
        statusCode: 429,
      });
      reply.header('Retry-After', String(createLimit.retryAfterSec));
      reply.code(429).send({ error: 'too many beta trial attempts, try again in a minute' });
      return;
    }
    const parsed = await parseSessionForm(req, reply, { maxPdfBytes: BETA_PDF_MAX_BYTES });
    if (!parsed) {
      recordTrialAudit(req, {
        flow: 'beta',
        allowed: false,
        reason: 'invalid_form',
        statusCode: reply.statusCode >= 400 ? reply.statusCode : 400,
      });
      return;
    }
    const { fields } = parsed;
    const lead = normalizeBetaLead(fields);
    if (!lead.ok) {
      await cleanupParsedUpload(parsed);
      const email = auditEmail(fields.email);
      recordTrialAudit(req, {
        flow: 'beta',
        allowed: false,
        reason: 'invalid_lead',
        email,
        normalizedEmail: email,
        statusCode: 400,
        detail: lead.error,
      });
      reply.code(400).send({ error: lead.error });
      return;
    }
    if (!env.GEMINI_API_KEY.trim()) {
      await cleanupParsedUpload(parsed);
      recordTrialAudit(req, {
        flow: 'beta',
        allowed: false,
        reason: 'hosted_key_unavailable',
        email: lead.lead.email,
        normalizedEmail: lead.lead.normalized_email,
        statusCode: 503,
      });
      reply.code(503).send({ error: 'hosted beta trials are not available right now' });
      return;
    }
    if (getBetaLeadByNormalizedEmail(lead.lead.normalized_email)) {
      recordBetaLeadDuplicate(lead.lead.normalized_email);
      await cleanupParsedUpload(parsed);
      recordTrialAudit(req, {
        flow: 'beta',
        allowed: false,
        reason: 'duplicate_email',
        email: lead.lead.email,
        normalizedEmail: lead.lead.normalized_email,
        statusCode: 409,
      });
      reply.code(409).send({ error: 'a beta trial has already been used for this email address' });
      return;
    }

    const slug = nanoid(8);
    const hostToken = nanoid(32);
    if (!registerTrial(slug, {
      geminiKey: env.GEMINI_API_KEY,
      hostToken,
      maxViewers: BETA_MAX_VIEWERS,
      ttlMs: env.TRIAL_TTL_MS,
      runtimeMs: BETA_RUNTIME_MS,
      onExpire: cleanupTrialSession,
    })) {
      await cleanupParsedUpload(parsed);
      recordTrialAudit(req, {
        flow: 'beta',
        allowed: false,
        reason: 'active_trial_capacity',
        email: lead.lead.email,
        normalizedEmail: lead.lead.normalized_email,
        statusCode: 503,
      });
      reply.code(503).send({ error: 'too many active trials right now — please try again shortly' });
      return;
    }

    let slideRef = '';
    try {
      slideRef = await finalizeParsedUpload(parsed);
      createBetaTrialSession({
        session: {
          slug,
          title: (fields.title ?? '').slice(0, 200),
          target_lang: fields.targetLang,
          slide_type: fields.slideType,
          slide_ref: slideRef,
          slide_count: parsed.slideCount,
          echo_target_language: fields.echoTargetLanguage === 'true',
          presentation_mode: fields.presentationMode === 'remote' ? 'remote' : 'in_person',
        },
        lead: lead.lead,
      });
      recordTrialAudit(req, {
        flow: 'beta',
        allowed: true,
        reason: 'created',
        email: lead.lead.email,
        normalizedEmail: lead.lead.normalized_email,
        sessionSlug: slug,
        statusCode: 200,
      });
    } catch (err) {
      unregisterTrial(slug);
      await cleanupParsedUpload(parsed);
      await slideStorage.remove(slideRef);
      if (getBetaLeadByNormalizedEmail(lead.lead.normalized_email)) {
        recordBetaLeadDuplicate(lead.lead.normalized_email);
        recordTrialAudit(req, {
          flow: 'beta',
          allowed: false,
          reason: 'duplicate_email',
          email: lead.lead.email,
          normalizedEmail: lead.lead.normalized_email,
          statusCode: 409,
        });
        reply.code(409).send({ error: 'a beta trial has already been used for this email address' });
        return;
      }
      recordTrialAudit(req, {
        flow: 'beta',
        allowed: false,
        reason: 'server_error',
        email: lead.lead.email,
        normalizedEmail: lead.lead.normalized_email,
        statusCode: 500,
      });
      throw err;
    }

    return {
      slug,
      hostToken,
      viewerPath: `/${slug}`,
      hostPath: `/${slug}/host`,
    };
  });

  app.post('/api/beta/trial/:slug/expedite', async (req, reply) => {
    const { slug } = req.params as { slug: string };
    if (!SLUG_ALPHABET_RE.test(slug)) {
      reply.code(400).send({ error: 'bad slug' });
      return;
    }
    if (!authorizeSession(req, reply, slug)) return;
    const session = getSessionBySlug(slug);
    if (!session || session.trial_type !== 'beta') {
      reply.code(404).send({ error: 'beta trial not found' });
      return;
    }
    const lead = recordBetaLeadExpedite(slug);
    if (!lead) {
      reply.code(404).send({ error: 'beta lead not found' });
      return;
    }
    return {
      ok: true,
      expediteRequested: lead.expedite_requested === 1,
      expediteRequestedAt: lead.expedite_requested_at,
    };
  });

  app.post('/api/beta/trial/:slug/feedback', async (req, reply) => {
    const { slug } = req.params as { slug: string };
    if (!SLUG_ALPHABET_RE.test(slug)) {
      reply.code(400).send({ error: 'bad slug' });
      return;
    }
    if (!authorizeSession(req, reply, slug)) return;
    const session = getSessionBySlug(slug);
    if (!session || session.trial_type !== 'beta') {
      reply.code(404).send({ error: 'beta trial not found' });
      return;
    }
    const body = (req.body ?? {}) as { rating?: unknown; feedback?: unknown };
    const rating =
      typeof body.rating === 'number' && Number.isInteger(body.rating) ? body.rating : NaN;
    if (rating < 1 || rating > 5) {
      reply.code(400).send({ error: 'rating must be an integer from 1 to 5' });
      return;
    }
    const feedback = normalizeTextField(typeof body.feedback === 'string' ? body.feedback : '', 2000);
    const lead = recordBetaLeadFeedback({
      session_slug: slug,
      rating,
      feedback_text: feedback,
    });
    if (!lead) {
      reply.code(404).send({ error: 'beta lead not found' });
      return;
    }
    return {
      ok: true,
      rating: lead.feedback_rating,
      feedback: lead.feedback_text,
      feedbackSubmittedAt: lead.feedback_submitted_at,
    };
  });

  /** Public session info for viewer/host pages. Never includes secrets. */
  app.get('/api/sessions/:slug', async (req, reply) => {
    if (!allowPublicGet(req, reply)) return;
    const { slug } = req.params as { slug: string };
    if (!SLUG_ALPHABET_RE.test(slug)) {
      reply.code(400).send({ error: 'bad slug' });
      return;
    }
    const session = getSessionBySlug(slug);
    if (!session) {
      reply.code(404).send({ error: 'session not found' });
      return;
    }
    const room = getRoom(slug);
    const slideUrl =
      session.slide_type === 'pdf'
        ? slideStorage.publicUrl(session.slide_ref) ?? `/uploads/${session.slide_ref}`
        : session.slide_ref;
    return {
      slug: session.slug,
      title: session.title,
      targetLang: session.target_lang,
      slideType: session.slide_type,
      slideUrl,
      slideCount: session.slide_count,
      state: room?.state ?? session.state,
      slideIndex: room?.slideIndex ?? 0,
      startedAt: session.started_at,
      endedAt: session.ended_at,
      presentationMode: session.presentation_mode,
      trialKind: session.trial_type === 'beta' || session.trial_type === 'try' ? session.trial_type : null,
      trialRuntimeMs:
        session.trial_type === 'beta'
          ? BETA_RUNTIME_MS
          : session.trial_type === 'try'
            ? TRY_RUNTIME_MS
            : null,
      trialMaxViewers:
        session.trial_type === 'beta'
          ? BETA_MAX_VIEWERS
          : session.trial_type === 'try'
            ? TRY_MAX_VIEWERS
            : null,
      audio: audioFanout.infoForSession(session),
    };
  });

  app.post('/api/sessions/:slug/audio/subscribe', async (req, reply) => {
    if (!allowPublicGet(req, reply)) return;
    const { slug } = req.params as { slug: string };
    if (!SLUG_ALPHABET_RE.test(slug)) {
      reply.code(400).send({ error: 'bad slug' });
      return;
    }
    const session = getSessionBySlug(slug);
    if (!session) {
      reply.code(404).send({ error: 'session not found' });
      return;
    }

    const body = (req.body ?? {}) as {
      sessionDescription?: SessionDescription;
      recoverPublisher?: unknown;
      publisherGeneration?: unknown;
      reason?: unknown;
    };
    if (
      !body.sessionDescription ||
      typeof body.sessionDescription !== 'object' ||
      typeof body.sessionDescription.type !== 'string'
    ) {
      reply.code(400).send({ error: 'sessionDescription is required' });
      return;
    }

    try {
      const opts: RealtimeSubscribeOptions = {
        recoverPublisher: body.recoverPublisher === true,
        publisherGeneration:
          typeof body.publisherGeneration === 'number' && Number.isFinite(body.publisherGeneration)
            ? Math.max(0, Math.floor(body.publisherGeneration))
            : undefined,
        reason: typeof body.reason === 'string' ? body.reason.slice(0, 200) : undefined,
      };
      return await audioFanout.subscribe(slug, body.sessionDescription, opts);
    } catch (err) {
      const e = err as Error & { statusCode?: number; code?: string };
      const status = e.statusCode ?? 500;
      reply.code(status).send({ error: e.message, code: e.code ?? 'audio_subscribe_failed' });
    }
  });

  /** Public bilingual transcript (spec §6: /{slug}/transcript is public). */
  app.get('/api/sessions/:slug/transcript', async (req, reply) => {
    if (!allowPublicGet(req, reply)) return;
    const { slug } = req.params as { slug: string };
    const session = getSessionBySlug(slug);
    if (!session) {
      reply.code(404).send({ error: 'session not found' });
      return;
    }
    const rows = getTranscripts(session.id);
    return {
      title: session.title,
      targetLang: session.target_lang,
      state: getRoom(slug)?.state ?? session.state,
      startedAt: session.started_at,
      endedAt: session.ended_at,
      segments: rows.map((r) => ({
        kind: r.kind,
        languageCode: r.language_code,
        text: r.text,
        tOffsetMs: r.t_offset_ms,
        slideIndex: r.slide_index,
      })),
    };
  });

  /** Public: poll questions + final results (for the post-talk transcript page). */
  app.get('/api/sessions/:slug/polls', async (req, reply) => {
    if (!allowPublicGet(req, reply)) return;
    const { slug } = req.params as { slug: string };
    const session = getSessionBySlug(slug);
    if (!session) {
      reply.code(404).send({ error: 'session not found' });
      return;
    }
    return { polls: getPollResults(session.id) };
  });

  /** Admin-only attendance analytics for a session. */
  app.get('/api/sessions/:slug/analytics', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const { slug } = req.params as { slug: string };
    if (!authorizeSession(req, reply, slug)) return;
    const session = getSessionBySlug(slug);
    if (!session) {
      reply.code(404).send({ error: 'session not found' });
      return;
    }
    const room = getRoom(slug);
    const active = room?.activeWatchMs() ?? new Map<string, number>();

    // Merge persisted watch time with any in-progress (still-connected) time.
    const allAttendees = getAttendees(session.id).map((a) => ({
      name: a.name,
      company: a.company,
      joins: a.joins,
      watchedMs: a.total_ms + (active.get(a.viewer_id) ?? 0),
      firstJoinedAt: a.first_joined_at,
      lastSeenAt: a.last_seen_at,
    }));

    const totalWatchMs = allAttendees.reduce((s, a) => s + a.watchedMs, 0);
    const withTime = allAttendees.filter((a) => a.watchedMs > 0).length;
    const attendeeListTruncated = allAttendees.length > ATTENDEE_ANALYTICS_LIMIT;

    return {
      state: room?.state ?? session.state,
      live: room?.activeViewerCount ?? 0,
      uniqueAttendees: allAttendees.length,
      peakConcurrent: Math.max(room?.peak ?? 0, session.peak_viewers ?? 0),
      totalWatchMs,
      avgWatchMs: withTime ? Math.round(totalWatchMs / withTime) : 0,
      namedCount: allAttendees.filter((a) => a.name || a.company).length,
      attendeeListTruncated,
      attendeeLimit: ATTENDEE_ANALYTICS_LIMIT,
      attendees: allAttendees.slice(0, ATTENDEE_ANALYTICS_LIMIT),
      reactions: getReactionTallies(session.id),
    };
  });

  /** Admin-only: list all talks (most recent first) for the dashboard. */
  app.get('/api/sessions', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    return getAllSessions().map((s) => ({
      slug: s.slug,
      title: s.title,
      targetLang: s.target_lang,
      slideType: s.slide_type,
      echoTargetLanguage: s.echo_target_language === 1,
      state: getRoom(s.slug)?.state ?? s.state,
      createdAt: s.created_at,
      startedAt: s.started_at,
      endedAt: s.ended_at,
      peakViewers: s.peak_viewers,
      attendeeCount: s.attendee_count,
      liveViewers: getRoom(s.slug)?.viewers.size ?? 0,
      presentationMode: s.presentation_mode,
    }));
  });

  /** Admin-only: durable hosted-beta leads, including duplicate attempts. */
  app.get('/api/beta/leads', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    return getBetaLeads().map((lead) => ({
      id: lead.id,
      email: lead.email,
      normalizedEmail: lead.normalized_email,
      fullName: lead.full_name,
      company: lead.company,
      budget: lead.budget,
      sessionSlug: lead.session_slug,
      duplicateAttempts: lead.duplicate_attempts,
      expediteRequested: lead.expedite_requested === 1,
      expediteRequestedAt: lead.expedite_requested_at,
      feedbackRating: lead.feedback_rating,
      feedback: lead.feedback_text,
      feedbackSubmittedAt: lead.feedback_submitted_at,
      firstTrialAt: lead.first_trial_at,
      lastDuplicateAt: lead.last_duplicate_at,
      createdAt: lead.created_at,
      updatedAt: lead.updated_at,
    }));
  });

  /** Admin-only: edit a talk's title / target language / echo toggle. */
  app.patch('/api/sessions/:slug', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { slug } = req.params as { slug: string };
    if (!getSessionBySlug(slug)) {
      reply.code(404).send({ error: 'session not found' });
      return;
    }
    const body = (req.body ?? {}) as {
      title?: string;
      targetLang?: string;
      echoTargetLanguage?: boolean;
    };
    if (body.targetLang !== undefined && !isSupportedLanguage(body.targetLang)) {
      reply.code(400).send({ error: `unsupported target language: ${body.targetLang}` });
      return;
    }
    const updated = updateSessionMeta(slug, {
      title: body.title,
      target_lang: body.targetLang,
      echo_target_language: body.echoTargetLanguage,
    });
    // Keep an in-memory room's config in sync so the next (re)start uses it.
    const room = getRoom(slug);
    if (room && updated) {
      room.session.title = updated.title;
      room.session.target_lang = updated.target_lang;
      room.session.echo_target_language = updated.echo_target_language;
    }
    return { ok: true };
  });

  /** Admin-only: delete a talk, its transcripts/attendees, room, and upload. */
  app.delete('/api/sessions/:slug', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { slug } = req.params as { slug: string };
    deleteRoom(slug);
    const removed = deleteSession(slug);
    if (!removed) {
      reply.code(404).send({ error: 'session not found' });
      return;
    }
    // Clean up an uploaded PDF (ignore external URLs, legacy HTML, and missing files).
    await slideStorage.remove(removed.slide_ref);
    return { ok: true };
  });
}
