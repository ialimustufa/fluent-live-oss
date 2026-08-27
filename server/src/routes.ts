import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { nanoid } from 'nanoid';
import fs from 'node:fs';
import path from 'node:path';
import { checkAdminSecret, isRateLimited, recordAuthFailure } from './auth.js';
import { createFixedWindow } from './rateLimit.js';
import {
  createSession,
  completePendingSlideDeletion,
  getSessionBySlug,
  getTranscripts,
  getAttendees,
  getAllSessions,
  getDb,
  updateSessionMeta,
  deleteSession,
  getPollResults,
  getReactionTallies,
} from './db.js';
import { isSupportedLanguage, SUPPORTED_LANGUAGES } from './languages.js';
import { getRoom, deleteRoom } from './rooms.js';
import fsp from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import type { Env } from './env.js';
import type { SlideStorage } from './storage.js';
import type { RealtimeAudioFanout, RealtimeSubscribeOptions, SessionDescription } from './realtime-audio.js';

const SLUG_ALPHABET_RE = /^[A-Za-z0-9_-]+$/;
// Generous per-IP ceiling for the unauthenticated public reads (session info,
// transcript, polls, languages): high enough not to affect a real viewer
// polling, low enough to stop a scraping/DoS loop.
const PUBLIC_GET_WINDOW_MS = 60_000;
const ATTENDEE_ANALYTICS_LIMIT = 500;
const SLIDE_CLEANUP_RETRY_MS = 30_000;

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

interface RouteDeps {
  slideStorage: SlideStorage;
  audioFanout: RealtimeAudioFanout;
}

function clientIp(req: FastifyRequest): string {
  return req.ip;
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

export function registerRoutes(app: FastifyInstance, env: Env, deps: RouteDeps): void {
  const { slideStorage, audioFanout } = deps;
  const publicGetLimiter = createFixedWindow({
    windowMs: PUBLIC_GET_WINDOW_MS,
    max: env.PUBLIC_GET_MAX,
  });
  const slideCleanupRetries = new Map<string, NodeJS.Timeout>();

  function scheduleSlideCleanupRetry(slideRef: string): void {
    if (slideCleanupRetries.has(slideRef)) return;
    const timer = setTimeout(async () => {
      slideCleanupRetries.delete(slideRef);
      try {
        if (await slideStorage.remove(slideRef)) {
          completePendingSlideDeletion(slideRef);
          return;
        }
      } catch (err) {
        app.log.warn({ err, slideRef }, 'unexpected slide cleanup retry failure');
      }
      scheduleSlideCleanupRetry(slideRef);
    }, SLIDE_CLEANUP_RETRY_MS);
    timer.unref();
    slideCleanupRetries.set(slideRef, timer);
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
    reply: FastifyReply
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
    if (!requireAdmin(req, reply)) return;
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
    if (removed.cleanup_pending) {
      if (await slideStorage.remove(removed.slide_ref)) {
        completePendingSlideDeletion(removed.slide_ref);
      } else {
        scheduleSlideCleanupRetry(removed.slide_ref);
        reply
          .code(503)
          .header('Retry-After', String(SLIDE_CLEANUP_RETRY_MS / 1_000))
          .send({ error: 'session deleted, but uploaded deck cleanup is still pending' });
        return;
      }
    }
    return { ok: true };
  });
}
