import Fastify from 'fastify';
import fastifyHelmet from '@fastify/helmet';
import fastifyMultipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './env.js';
import { completePendingSlideDeletion, initDb } from './db.js';
import { registerRoutes } from './routes.js';
import { attachWebSocketServer } from './ws.js';
import { closeAllRooms, configureRooms } from './rooms.js';
import { isGeneratedPdfUpload } from './uploads.js';
import { createSlideStorage } from './storage.js';
import { RealtimeAudioFanout } from './realtime-audio.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function originOf(value: string | null): string | null {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function unique<T>(values: (T | null | undefined)[]): T[] {
  return [...new Set(values.filter((v): v is T => Boolean(v)))];
}

async function main(): Promise<void> {
  const env = loadEnv();
  const { pendingSlideRefs } = initDb(env.DATABASE_PATH);
  const slideStorage = createSlideStorage(env);
  const audioFanout = new RealtimeAudioFanout(env);
  configureRooms(env.GEMINI_API_KEY, env.MAX_VIEWERS_PER_SESSION, audioFanout, {
    audioSyncMetadata: env.AUDIO_SYNC_METADATA,
  });
  fs.mkdirSync(env.UPLOADS_DIR, { recursive: true });

  const completedSlideDeletions = await slideStorage.removeMany(pendingSlideRefs);
  for (const slideRef of completedSlideDeletions) completePendingSlideDeletion(slideRef);
  const failedSlideDeletions = pendingSlideRefs.length - completedSlideDeletions.size;
  if (failedSlideDeletions > 0) {
    throw new Error(
      `Failed to remove ${failedSlideDeletions} pending slide object(s); cleanup remains queued for the next start.`
    );
  }

  const app = Fastify({
    logger: {
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.headers["set-cookie"]',
          'headers.authorization',
          'headers.cookie',
          'payload.auth',
          'ADMIN_SECRET',
          'GEMINI_API_KEY',
          'CF_REALTIME_APP_TOKEN',
          'CF_REALTIME_APP_SECRET',
          'R2_SECRET_ACCESS_KEY',
          'R2_CACHE_PURGE_API_TOKEN',
        ],
        censor: '[redacted]',
      },
    },
    trustProxy: env.TRUST_PROXY,
  });

  const r2Origin = originOf(env.R2_PUBLIC_BASE_URL);
  const assetCdnOrigin = originOf(env.ASSET_CDN_BASE_URL);
  const cdnOrigins = unique([r2Origin, assetCdnOrigin]);

  await app.register(fastifyHelmet, {
    global: true,
    // The app embeds external decks and PDF workers; COEP would break those.
    crossOriginEmbedderPolicy: false,
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
        scriptSrc: ["'self'", ...cdnOrigins, 'https://www.googletagmanager.com'],
        styleSrc: ["'self'", ...cdnOrigins, "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", ...cdnOrigins, 'data:'],
        connectSrc: [
          "'self'",
          ...cdnOrigins,
          'ws:',
          'wss:',
          'https://www.google-analytics.com',
          'https://region1.google-analytics.com',
        ],
        frameSrc: ['https:'],
        workerSrc: ["'self'", ...cdnOrigins, 'blob:'],
        mediaSrc: ["'self'", 'blob:', 'data:'],
      },
    },
  });

  await app.register(fastifyMultipart, {
    limits: { fileSize: 50 * 1024 * 1024, files: 1 },
  });

  // Uploaded slide files. Only generated PDFs are public; legacy uploaded HTML
  // decks deliberately fail closed instead of executing on the app origin. In
  // R2 mode this proxies through the app using private R2 credentials, so the
  // browser never needs direct bucket/CDN access or tokens.
  app.get('/uploads/:file', async (req, reply) => {
    const { file } = req.params as { file: string };
    if (!isGeneratedPdfUpload(file)) {
      reply.code(404).send({ error: 'not found' });
      return;
    }
    const pdf = await slideStorage.readPdf(file);
    if (!pdf) {
      reply.code(404).send({ error: 'not found' });
      return;
    }
    if (pdf.contentLength !== undefined) reply.header('Content-Length', String(pdf.contentLength));
    return reply
      .type('application/pdf')
      .header('Cache-Control', 'private, no-store, max-age=0')
      .send(pdf.body);
  });

  registerRoutes(app, env, { slideStorage, audioFanout });

  // Built client (client/dist) — present in production, absent in dev
  // (the Vite dev server proxies /api, /ws and /uploads to us instead).
  const clientDist = path.resolve(__dirname, '../../client/dist');
  if (fs.existsSync(clientDist)) {
    await app.register(fastifyStatic, {
      root: clientDist,
      prefix: '/',
      decorateReply: false,
      setHeaders(reply, filePath) {
        if (filePath.endsWith('.mjs')) {
          reply.header('Content-Type', 'text/javascript; charset=utf-8');
        }
      },
    });
    // SPA fallback for /{slug}, /{slug}/host, /{slug}/transcript, /new
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/') && !req.url.startsWith('/uploads/')) {
        reply.type('text/html').send(fs.readFileSync(path.join(clientDist, 'index.html')));
      } else {
        reply.code(404).send({ error: 'not found' });
      }
    });
  }

  attachWebSocketServer(app.server, env.ADMIN_SECRET, env.TRUST_PROXY, {
    enableTestHooks: env.ENABLE_TEST_HOOKS,
    handleUpgrade: (req, socket, head) => audioFanout.handleUpgrade(req, socket, head),
  });

  // Surface unhandled route errors through the redacted logger rather than
  // leaking internals to clients.
  app.setErrorHandler((err, req, reply) => {
    req.log.error({ err }, 'unhandled route error');
    const statusCode = (err as { statusCode?: number }).statusCode ?? 500;
    if (!reply.sent) reply.code(statusCode).send({ error: 'internal error' });
  });

  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, 'shutting down');
    const forceExit = setTimeout(() => process.exit(1), 10_000);
    forceExit.unref?.();
    try {
      closeAllRooms();
      await app.close();
      clearTimeout(forceExit);
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, 'graceful shutdown failed');
      process.exit(1);
    }
  };
  process.once('SIGTERM', (signal) => void shutdown(signal));
  process.once('SIGINT', (signal) => void shutdown(signal));

  // A rejected promise with no handler shouldn't take the process down silently;
  // an uncaught exception leaves us in an unknown state, so log and shut down.
  process.on('unhandledRejection', (reason) => {
    app.log.error({ err: reason }, 'unhandled promise rejection');
  });
  process.on('uncaughtException', (err) => {
    app.log.fatal({ err }, 'uncaught exception — shutting down');
    void shutdown('SIGTERM');
  });

  // Optional error reporting: only wired up when SENTRY_DSN is set. The package
  // is an optional dependency, so a missing install degrades to a warning.
  if (env.SENTRY_DSN) {
    try {
      // Indirect specifier so the build doesn't require @sentry/node to be present;
      // it's an optional dependency installed only by deployments that want it.
      const sentryModule = '@sentry/node';
      const Sentry = (await import(sentryModule)) as { init(opts: { dsn: string }): void };
      Sentry.init({ dsn: env.SENTRY_DSN });
      app.log.info('Sentry error reporting enabled');
    } catch {
      app.log.warn('SENTRY_DSN is set but @sentry/node is not installed — error reporting disabled');
    }
  }

  await app.listen({ port: env.PORT, host: env.HOST });
  app.log.info(`Fluent listening on ${env.HOST}:${env.PORT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
