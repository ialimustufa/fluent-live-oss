import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { nanoid } from 'nanoid';
import { WebSocket, WebSocketServer } from 'ws';
import type { Env } from './env.js';
import { pcm24kMonoBase64ToSfuFrames, type SfuFrame } from './audio-packet.js';
import type { SessionRow } from './db.js';
import type { AudioMarkerPayload } from './types.js';

const MAX_WS_BUFFERED_AMOUNT = 2_000_000;
const DEFAULT_DIAGNOSTIC_TIMEOUT_MS = 5_000;
// Pace 20ms PCM frames into the SFU at ~1× (a live-mic feed) so Cloudflare's
// adapter buffer never overruns. Gemini may emit translated audio faster than
// real-time; we queue it and drain steadily with only a small playout lead.
const DRAIN_TICK_MS = 10;
const SEND_LEAD_MS = 120;
// Safety ceiling only while the SFU ingest websocket is not connected. Once
// Cloudflare is connected, we prefer lag over cutting translated audio.
const MAX_DISCONNECTED_QUEUE_MS = 30_000;
const PUBLISHER_RECOVERY_DEBOUNCE_MS = 10_000;

type PendingAudioMarker = Omit<
  AudioMarkerPayload,
  'serverSentAtMs' | 'publisherGeneration' | 'sfuSentAtMs' | 'sfuQueueMs'
> & {
  onSent: (marker: AudioMarkerPayload) => void;
};

interface QueuedSfuFrame extends SfuFrame {
  marker?: PendingAudioMarker;
}

interface AudioSession {
  slug: string;
  token: string;
  trackName: string;
  endpoint: string;
  publisherGeneration: number;
  sessionId?: string;
  adapterId?: string;
  starting?: Promise<void>;
  recovery?: Promise<void>;
  sockets: Map<WebSocket, number>;
  // Paced delivery: queued frames + how much audio they represent, the wall-clock
  // time the next frame is due, and the drain timer.
  queue: QueuedSfuFrame[];
  queuedMs: number;
  nextSendMs: number;
  drainTimer: NodeJS.Timeout | null;
  restartTimer: NodeJS.Timeout | null;
  lastRecoveryMs: number;
  sentFrames: number;
  droppedMs: number;
}

type AudioUnavailableReason =
  | 'subscription_inactive'
  | 'not_configured'
  | 'not_started'
  | 'publish_failed';

export interface SessionAudioInfo {
  transport: 'sfu' | 'none';
  available: boolean;
  reason?: AudioUnavailableReason;
}

export interface SessionDescription {
  type: 'offer' | 'answer' | 'pranswer' | 'rollback';
  sdp?: string;
}

export interface RealtimeSubscribeAnswer {
  sessionDescription: SessionDescription;
  publisherGeneration: number;
}

export interface RealtimeSubscribeOptions {
  recoverPublisher?: boolean;
  publisherGeneration?: number;
  reason?: string;
}

export interface SfuDiagnosticCheck {
  name: 'env' | 'cloudflare_session' | 'websocket_adapter' | 'ingest_callback' | 'cleanup';
  ok: boolean;
  latencyMs?: number;
  code?: string;
  error?: string;
}

export interface SfuDiagnosticResult {
  ok: boolean;
  checks: SfuDiagnosticCheck[];
}

class CloudflareRealtimeError extends Error {
  constructor(
    public path: string,
    public realtimeStatus: number,
    public responseBody: string
  ) {
    super(`Cloudflare Realtime ${path} failed: ${realtimeStatus} ${responseBody}`);
  }
}

function originToWs(origin: string): string {
  return origin.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');
}

function publisherTrackName(slug: string, generation: number): string {
  return `translated-${slug}-g${generation}`;
}

function configured(env: Env): boolean {
  return Boolean(
    env.PUBLIC_ORIGIN &&
      env.CF_REALTIME_APP_ID &&
      env.CF_REALTIME_APP_SECRET &&
      env.CF_REALTIME_API_BASE
  );
}

export class RealtimeAudioFanout {
  private sessions = new Map<string, AudioSession>();
  private tokens = new Map<string, string>();
  private ingestWaiters = new Map<string, Set<() => void>>();
  private wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

  constructor(private env: Env) {}

  get active(): boolean {
    return this.env.AUDIO_SUBSCRIPTION_ACTIVE;
  }

  get usable(): boolean {
    return this.active && configured(this.env);
  }

  infoForSession(session: SessionRow): SessionAudioInfo {
    if (!this.active) {
      return { transport: 'none', available: false, reason: 'subscription_inactive' };
    }
    if (!configured(this.env)) {
      return { transport: 'none', available: false, reason: 'not_configured' };
    }
    if (session.state === 'ended') {
      return { transport: 'sfu', available: false, reason: 'not_started' };
    }
    return { transport: 'sfu', available: true };
  }

  async startSession(slug: string): Promise<void> {
    if (!this.usable) return;
    const session = this.getOrCreateSession(slug);
    if (session.sessionId && session.adapterId) return;
    if (session.starting) return session.starting;

    let starting: Promise<void>;
    starting = this.createPublisher(session)
      .catch((err) => {
        console.error(`[realtime-audio] failed to start publisher for ${slug}:`, err);
        throw err;
      })
      .finally(() => {
        if (session.starting === starting) session.starting = undefined;
      });
    session.starting = starting;
    return starting;
  }

  publishTranslated(slug: string, base64Pcm24kMono: string, marker?: PendingAudioMarker): void {
    if (!this.usable) return;
    const session = this.getOrCreateSession(slug);
    const frames = pcm24kMonoBase64ToSfuFrames(base64Pcm24kMono);
    if (frames.length === 0) return;

    for (const [idx, frame] of frames.entries()) {
      session.queue.push({ ...frame, ...(idx === 0 && marker ? { marker } : {}) });
      session.queuedMs += frame.durationMs;
    }
    this.capDisconnectedQueue(session);
    this.ensureDraining(session);

    void this.startSession(slug).catch(() => {
      /* logged in startSession */
    });
  }

  /** Queued-but-unsent audio (ms) for a slug — surfaced in the audio-sync log. */
  queueDepthMs(slug: string): number {
    return Math.round(this.sessions.get(slug)?.queuedMs ?? 0);
  }

  async subscribe(
    slug: string,
    offer: SessionDescription,
    opts: RealtimeSubscribeOptions = {}
  ): Promise<RealtimeSubscribeAnswer> {
    if (!this.active) {
      const err = new Error('audio subscription is inactive') as Error & { statusCode?: number; code?: string };
      err.statusCode = 403;
      err.code = 'audio_subscription_inactive';
      throw err;
    }
    if (!configured(this.env)) {
      const err = new Error('Cloudflare Realtime audio is not configured') as Error & { statusCode?: number; code?: string };
      err.statusCode = 503;
      err.code = 'audio_not_configured';
      throw err;
    }

    const session = this.getOrCreateSession(slug);
    if (opts.recoverPublisher) {
      await this.recoverPublisher(session, opts.publisherGeneration, opts.reason ?? 'viewer requested recovery');
    }
    await this.startSession(slug);
    const publisher = this.sessions.get(slug);
    if (!publisher?.sessionId) {
      const err = new Error('translated audio track is not ready') as Error & { statusCode?: number; code?: string };
      err.statusCode = 503;
      err.code = 'audio_not_ready';
      throw err;
    }

    const { sessionId: viewerSessionId } = await this.createRealtimeSession();
    const answer = await this.realtimeFetch<{ sessionDescription?: SessionDescription }>(
      `/sessions/${viewerSessionId}/tracks/new`,
      {
        method: 'POST',
        body: {
          sessionDescription: offer,
          tracks: [
            {
              location: 'remote',
              sessionId: publisher.sessionId,
              trackName: publisher.trackName,
              kind: 'audio',
            },
          ],
        },
      }
    );

    if (!answer.sessionDescription) {
      throw new Error('Cloudflare Realtime did not return a sessionDescription');
    }
    return {
      sessionDescription: answer.sessionDescription,
      publisherGeneration: publisher.publisherGeneration,
    };
  }

  async close(slug: string): Promise<void> {
    const session = this.sessions.get(slug);
    if (!session) return;
    this.detachSession(session);
    await this.closeAdapter(session).catch((err) => {
      console.warn(`[realtime-audio] failed to close adapter for ${slug}:`, err);
    });
  }

  closeAll(): void {
    for (const slug of [...this.sessions.keys()]) {
      void this.close(slug);
    }
    this.wss.close();
  }

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const pathname = req.url?.split('?')[0] ?? '';
    const match = /^\/audio\/ingest\/([A-Za-z0-9_-]+)$/.exec(pathname);
    if (!match) return false;

    const token = match[1];
    const slug = this.tokens.get(token);
    if (!slug) {
      socket.destroy();
      return true;
    }

    this.wss.handleUpgrade(req, socket, head, (ws) => {
      const session = this.sessions.get(slug);
      if (!session || session.token !== token) {
        ws.close(4404, 'unknown audio session');
        return;
      }
      const generation = session.publisherGeneration;
      session.sockets.set(ws, generation);
      this.notifyIngestConnection(slug);
      this.ensureDraining(session);
      ws.on('close', (code, reason) => this.handleIngestClosed(session, ws, generation, code, reason.toString()));
      ws.on('error', () => ws.close());
    });
    return true;
  }

  async checkSetup(opts: { timeoutMs?: number } = {}): Promise<SfuDiagnosticResult> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_DIAGNOSTIC_TIMEOUT_MS;
    const checks: SfuDiagnosticCheck[] = [];
    let diagnosticSession: AudioSession | null = null;

    const finish = () => ({ ok: checks.every((check) => check.ok), checks });
    const failEnv = (code: string, error: string): SfuDiagnosticResult => {
      checks.push({ name: 'env', ok: false, code, error });
      return finish();
    };
    const timed = async (
      name: SfuDiagnosticCheck['name'],
      code: string,
      fn: () => Promise<void>
    ): Promise<boolean> => {
      const started = Date.now();
      try {
        await fn();
        checks.push({ name, ok: true, latencyMs: Date.now() - started });
        return true;
      } catch (err) {
        checks.push({
          name,
          ok: false,
          latencyMs: Date.now() - started,
          code: classifyDiagnosticError(code, err),
          error: sanitizeError(err),
        });
        return false;
      }
    };

    if (!this.env.AUDIO_SUBSCRIPTION_ACTIVE) {
      return failEnv('audio_subscription_inactive', 'AUDIO_SUBSCRIPTION_ACTIVE must be true.');
    }
    if (!this.env.PUBLIC_ORIGIN) {
      return failEnv('not_configured', 'PUBLIC_ORIGIN is required.');
    }
    if (!this.env.PUBLIC_ORIGIN.startsWith('https://')) {
      return failEnv('public_origin_not_https', 'PUBLIC_ORIGIN must be an https:// origin for Cloudflare callbacks.');
    }
    if (!this.env.CF_REALTIME_APP_ID || !this.env.CF_REALTIME_APP_SECRET || !this.env.CF_REALTIME_API_BASE) {
      return failEnv('not_configured', 'Cloudflare Realtime app ID, secret, and API base are required.');
    }

    checks.push({ name: 'env', ok: true });

    const sessionOk = await timed('cloudflare_session', 'cloudflare_session_failed', async () => {
      await this.createRealtimeSession();
    });
    if (!sessionOk) return finish();

    const slug = `sfu-check-${nanoid(10)}`;
    diagnosticSession = this.getOrCreateSession(slug);
    diagnosticSession.trackName = `diagnostic-${slug}`;

    const adapterOk = await timed('websocket_adapter', 'adapter_create_failed', async () => {
      if (!diagnosticSession) throw new Error('diagnostic session missing');
      await this.createPublisher(diagnosticSession);
    });

    if (adapterOk && diagnosticSession) {
      await timed('ingest_callback', 'ingest_callback_timeout', async () => {
        await this.waitForIngestConnection(diagnosticSession, timeoutMs);
      });
    }

    if (diagnosticSession) {
      await timed('cleanup', 'cleanup_failed', async () => {
        if (!diagnosticSession) return;
        this.detachSession(diagnosticSession);
        await this.closeAdapter(diagnosticSession);
      });
    }

    return finish();
  }

  private getOrCreateSession(slug: string): AudioSession {
    let session = this.sessions.get(slug);
    if (session) return session;
    const token = nanoid(32);
    const publisherGeneration = 1;
    const trackName = publisherTrackName(slug, publisherGeneration);
    const endpoint = `${originToWs(this.env.PUBLIC_ORIGIN ?? '')}/audio/ingest/${token}`;
    session = {
      slug,
      token,
      trackName,
      endpoint,
      publisherGeneration,
      sockets: new Map(),
      queue: [],
      queuedMs: 0,
      nextSendMs: 0,
      drainTimer: null,
      restartTimer: null,
      lastRecoveryMs: 0,
      sentFrames: 0,
      droppedMs: 0,
    };
    this.sessions.set(slug, session);
    this.tokens.set(token, slug);
    return session;
  }

  private async createPublisher(session: AudioSession): Promise<void> {
    const generation = session.publisherGeneration;
    const trackName = session.trackName;
    const endpoint = session.endpoint;
    const res = await this.realtimeFetch<{ tracks?: { sessionId?: string; adapterId?: string }[] }>(
      '/adapters/websocket/new',
      {
        method: 'POST',
        body: {
          tracks: [
            {
              location: 'local',
              trackName,
              endpoint,
              inputCodec: 'pcm',
              mode: 'buffer',
            },
          ],
        },
      }
    );
    const track = res.tracks?.[0];
    if (!track?.sessionId || !track.adapterId) {
      throw new Error('Cloudflare Realtime adapter response missing sessionId/adapterId');
    }
    if (
      session.publisherGeneration !== generation ||
      session.trackName !== trackName ||
      session.endpoint !== endpoint
    ) {
      await this.closeAdapterById(track.adapterId).catch(() => {});
      console.warn(
        `[realtime-audio] ignored stale publisher for ${session.slug} generation=${generation} ` +
          `current=${session.publisherGeneration}`
      );
      return;
    }
    session.sessionId = track.sessionId;
    session.adapterId = track.adapterId;
    session.nextSendMs = 0;
    console.info(
      `[realtime-audio] publisher ready for ${session.slug} generation=${session.publisherGeneration} ` +
        `session=${session.sessionId} track=${session.trackName}`
    );
  }

  private async createRealtimeSession(): Promise<{ sessionId: string }> {
    const res = await this.realtimeFetch<{ sessionId?: string }>('/sessions/new', { method: 'POST' });
    if (!res.sessionId) throw new Error('Cloudflare Realtime session response missing sessionId');
    return { sessionId: res.sessionId };
  }

  private async recoverPublisher(
    session: AudioSession,
    requestedGeneration: number | undefined,
    reason: string
  ): Promise<void> {
    if (requestedGeneration !== undefined && requestedGeneration < session.publisherGeneration) {
      console.info(
        `[realtime-audio] ${session.slug}: recovery skipped; viewer generation=${requestedGeneration} ` +
          `current=${session.publisherGeneration}`
      );
      return;
    }
    if (session.recovery) return session.recovery;

    const now = Date.now();
    if (now - session.lastRecoveryMs < PUBLISHER_RECOVERY_DEBOUNCE_MS) {
      console.warn(
        `[realtime-audio] ${session.slug}: recovery debounced current=${session.publisherGeneration} ` +
          `queueMs=${Math.round(session.queuedMs)} reason=${reason}`
      );
      return;
    }

    session.recovery = (async () => {
      session.lastRecoveryMs = Date.now();
      const oldGeneration = session.publisherGeneration;
      const oldAdapterId = session.adapterId;
      const oldSocketCount = session.sockets.size;

      console.warn(
        `[realtime-audio] ${session.slug}: recovering publisher generation=${oldGeneration} ` +
          `queueMs=${Math.round(session.queuedMs)} sentFrames=${session.sentFrames} ` +
          `sockets=${oldSocketCount} reason=${reason}`
      );

      session.sessionId = undefined;
      session.adapterId = undefined;
      session.nextSendMs = 0;
      session.starting = undefined;

      for (const ws of session.sockets.keys()) {
        session.sockets.delete(ws);
        try {
          ws.close(1012, 'publisher recovery');
        } catch {
          /* socket is already closing */
        }
      }

      this.rotatePublisherIdentity(session);
      if (oldAdapterId) {
        await this.closeAdapterById(oldAdapterId).catch((err) => {
          console.warn(`[realtime-audio] failed to close stale adapter for ${session.slug}:`, err);
        });
      }
      await this.startSession(session.slug);
      this.ensureDraining(session);
    })().finally(() => {
      session.recovery = undefined;
    });

    return session.recovery;
  }

  private rotatePublisherIdentity(session: AudioSession): void {
    this.tokens.delete(session.token);
    session.publisherGeneration += 1;
    session.token = nanoid(32);
    session.trackName = publisherTrackName(session.slug, session.publisherGeneration);
    session.endpoint = `${originToWs(this.env.PUBLIC_ORIGIN ?? '')}/audio/ingest/${session.token}`;
    this.tokens.set(session.token, session.slug);
  }

  private capDisconnectedQueue(session: AudioSession): void {
    const hasOpenIngest = [...session.sockets].some(
      ([ws, generation]) => generation === session.publisherGeneration && ws.readyState === ws.OPEN
    );
    if (hasOpenIngest) return;

    while (session.queuedMs > MAX_DISCONNECTED_QUEUE_MS && session.queue.length > 0) {
      const dropped = session.queue.shift()!;
      session.queuedMs -= dropped.durationMs;
      session.droppedMs += dropped.durationMs;
    }
    if (session.droppedMs > 0 && session.queuedMs <= MAX_DISCONNECTED_QUEUE_MS) {
      console.warn(
        `[realtime-audio] ${session.slug}: ingest disconnected; queue exceeded ` +
          `${MAX_DISCONNECTED_QUEUE_MS}ms, dropped ${Math.round(session.droppedMs)}ms of unavailable audio`
      );
      session.droppedMs = 0;
    }
  }

  private handleIngestClosed(
    session: AudioSession,
    ws: WebSocket,
    generation: number,
    code: number,
    reason: string
  ): void {
    session.sockets.delete(ws);
    if (generation !== session.publisherGeneration) {
      console.warn(
        `[realtime-audio] stale ingest closed for ${session.slug} generation=${generation} ` +
          `current=${session.publisherGeneration} code=${code} reason=${reason || '(none)'}`
      );
      return;
    }
    console.warn(
      `[realtime-audio] ingest closed for ${session.slug} generation=${generation} ` +
        `code=${code} reason=${reason || '(none)'} queueMs=${Math.round(session.queuedMs)}`
    );
    if (
      [...session.sockets].some(
        ([socket, socketGeneration]) =>
          socketGeneration === session.publisherGeneration && socket.readyState === socket.OPEN
      )
    ) {
      return;
    }

    // The old Cloudflare publisher track can remain visible to viewers as a
    // silent WebRTC track. Clear it so the next subscribe/start creates a fresh
    // publisher session, and let viewers resubscribe when their decoded audio
    // energy stalls.
    session.sessionId = undefined;
    session.adapterId = undefined;
    session.nextSendMs = 0;
    this.schedulePublisherRestart(session);
  }

  private schedulePublisherRestart(session: AudioSession): void {
    if (!this.usable || session.restartTimer || session.starting || session.queue.length === 0) return;
    session.restartTimer = setTimeout(() => {
      session.restartTimer = null;
      if (session.queue.length === 0) return;
      void this.startSession(session.slug).catch((err) => {
        console.error(`[realtime-audio] failed to restart publisher for ${session.slug}:`, err);
      });
    }, 250);
    session.restartTimer.unref?.();
  }

  private ensureDraining(session: AudioSession): void {
    if (session.drainTimer || session.queue.length === 0) return;
    const tick = (): void => {
      session.drainTimer = null;
      this.drainTick(session);
      if (session.queue.length > 0) {
        session.drainTimer = setTimeout(tick, DRAIN_TICK_MS);
        session.drainTimer.unref?.();
      }
    };
    tick();
  }

  /**
   * Release frames whose scheduled time has arrived, advancing a per-session
   * clock by each frame's duration so delivery tracks real time (1×). The clock
   * is reset forward to "now" after any gap (idle or no ingest socket) so we
   * never burst a backlog into the adapter.
   */
  private drainTick(session: AudioSession): void {
    const now = Date.now();
    if (session.nextSendMs < now) session.nextSendMs = now;

    const open = [...session.sockets]
      .filter(([ws, generation]) => generation === session.publisherGeneration && ws.readyState === ws.OPEN)
      .map(([ws]) => ws);
    if (open.length === 0) return; // ingest not connected yet; keep queue, retry next tick

    while (session.queue.length > 0) {
      // Not yet time for this frame (we're already fed LEAD ms ahead).
      if (session.nextSendMs > now + SEND_LEAD_MS) break;
      // All adapter sockets are backed up — pause rather than close the track.
      if (open.every((ws) => ws.bufferedAmount > MAX_WS_BUFFERED_AMOUNT)) break;

      const frame = session.queue.shift()!;
      session.queuedMs -= frame.durationMs;
      let sent = false;
      for (const ws of open) {
        if (ws.readyState === ws.OPEN && ws.bufferedAmount <= MAX_WS_BUFFERED_AMOUNT) {
          // Runs in a timer callback — a send throw must not escape to
          // uncaughtException (which would shut the whole server down).
          try {
            ws.send(frame.packet);
            sent = true;
          } catch {
            /* socket is going away; its close handler will drop it */
          }
        }
      }
      if (sent) {
        session.sentFrames += 1;
        if (frame.marker) {
          const sfuSentAtMs = Date.now();
          frame.marker.onSent({
            track: frame.marker.track,
            streamId: frame.marker.streamId,
            audioSeq: frame.marker.audioSeq,
            audioStartMs: frame.marker.audioStartMs,
            durationMs: frame.marker.durationMs,
            serverSentAtMs: sfuSentAtMs,
            publisherGeneration: session.publisherGeneration,
            sfuSentAtMs,
            sfuQueueMs: Math.round(session.queuedMs),
          });
          frame.marker = undefined;
        }
      }
      session.nextSendMs += frame.durationMs;
    }
    if (session.queuedMs < 0) session.queuedMs = 0;
  }

  private waitForIngestConnection(session: AudioSession, timeoutMs: number): Promise<void> {
    for (const [ws, generation] of session.sockets) {
      if (generation === session.publisherGeneration && ws.readyState === ws.OPEN) return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const waiters = this.ingestWaiters.get(session.slug) ?? new Set<() => void>();
      const timeout = setTimeout(() => {
        waiters.delete(onConnect);
        if (waiters.size === 0) this.ingestWaiters.delete(session.slug);
        reject(new Error(`Cloudflare did not connect to ${session.endpoint} within ${timeoutMs}ms`));
      }, timeoutMs);
      timeout.unref?.();

      const onConnect = () => {
        clearTimeout(timeout);
        waiters.delete(onConnect);
        if (waiters.size === 0) this.ingestWaiters.delete(session.slug);
        resolve();
      };
      waiters.add(onConnect);
      this.ingestWaiters.set(session.slug, waiters);
    });
  }

  private notifyIngestConnection(slug: string): void {
    const waiters = this.ingestWaiters.get(slug);
    if (!waiters) return;
    for (const waiter of [...waiters]) waiter();
  }

  private detachSession(session: AudioSession): void {
    this.sessions.delete(session.slug);
    this.tokens.delete(session.token);
    this.ingestWaiters.delete(session.slug);
    if (session.drainTimer) {
      clearTimeout(session.drainTimer);
      session.drainTimer = null;
    }
    if (session.restartTimer) {
      clearTimeout(session.restartTimer);
      session.restartTimer = null;
    }
    for (const ws of session.sockets.keys()) ws.close(1000, 'audio session closed');
    session.sockets.clear();
    session.queue = [];
    session.queuedMs = 0;
  }

  private async closeAdapter(session: AudioSession): Promise<void> {
    if (!session.adapterId || !configured(this.env)) return;
    await this.closeAdapterById(session.adapterId);
  }

  private async closeAdapterById(adapterId: string): Promise<void> {
    if (!configured(this.env)) return;
    await this.realtimeFetch('/adapters/websocket/close', {
      method: 'POST',
      body: { tracks: [{ adapterId }] },
      tolerateAdapterNotFound: true,
    });
  }

  private async realtimeFetch<T = unknown>(
    path: string,
    opts: {
      method: 'POST' | 'PUT' | 'GET';
      body?: unknown;
      tolerateAdapterNotFound?: boolean;
    }
  ): Promise<T> {
    const appId = this.env.CF_REALTIME_APP_ID;
    const secret = this.env.CF_REALTIME_APP_SECRET;
    if (!appId || !secret) throw new Error('Cloudflare Realtime credentials are not configured');

    const res = await fetch(`${this.env.CF_REALTIME_API_BASE}/apps/${appId}${path}`, {
      method: opts.method,
      headers: {
        Authorization: `Bearer ${secret}`,
        ...(opts.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    const text = await res.text();
    if (!res.ok) {
      if (opts.tolerateAdapterNotFound && res.status === 503 && text.includes('adapter_not_found')) {
        return {} as T;
      }
      throw new CloudflareRealtimeError(path, res.status, text);
    }
    if (!text) return {} as T;
    return JSON.parse(text) as T;
  }
}

function classifyDiagnosticError(fallback: string, err: unknown): string {
  if (err instanceof CloudflareRealtimeError) {
    if (err.realtimeStatus === 401 || err.realtimeStatus === 403) return 'bad_credentials';
    if (err.path === '/adapters/websocket/new') return 'adapter_create_failed';
    if (err.path === '/adapters/websocket/close') return 'cleanup_failed';
    return fallback;
  }
  return fallback;
}

function sanitizeError(err: unknown): string {
  if (err instanceof CloudflareRealtimeError) {
    return `Cloudflare Realtime ${err.path} failed with status ${err.realtimeStatus}`;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}
