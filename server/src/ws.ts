/**
 * ws.ts — app's own realtime channel. One WS namespace per slug at /ws/{slug}.
 *
 * Sockets connect unauthenticated and immediately send a `hello` message:
 *   { type: 'hello', payload: { role: 'host'|'viewer', auth?: '<ADMIN_SECRET>' } }
 * The secret travels in the handshake message body — never in the URL (§2).
 * Sockets that don't authenticate are viewer-only: any attempt to publish
 * `audio.in`, `slide.change`, or `control` is rejected and the socket closed.
 */
import { WebSocketServer, WebSocket } from 'ws';
import type { Server, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import crypto from 'node:crypto';
import { checkAdminSecret, isRateLimited, recordAuthFailure } from './auth.js';
import { getOrCreateRoom, getTrial, type Room } from './rooms.js';
import { envelope, type Envelope, type HelloPayload } from './types.js';

const HELLO_TIMEOUT_MS = 10_000;
const MAX_WS_PAYLOAD_BYTES = 256 * 1024;
const MAX_AUDIO_BASE64_CHARS = 64_000;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
// Host control-plane throttle: a generous ceiling on slide/poll/control messages
// so a buggy or malicious host can't flood the room. Audio chunks are excluded
// (they have their own size/format validation and stream at a steady rate).
const HOST_MSG_WINDOW_MS = 5_000;
const HOST_MSG_MAX = 30;
const VIEWER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const TEXT_CONTROL_RE = /[\u0000-\u001f\u007f]/g;
const MAX_PROFILE_TEXT_CHARS = 120;

export interface WsOptions {
  enableTestHooks: boolean;
  handleUpgrade?: (req: IncomingMessage, socket: Duplex, head: Buffer) => boolean;
}

/** Connection-scoped fixed-window counter (no shared state, no timers to clean up). */
function makeWindowCounter(windowMs: number, max: number): () => boolean {
  let count = 0;
  let resetAt = 0;
  return () => {
    const now = Date.now();
    if (now > resetAt) {
      count = 1;
      resetAt = now + windowMs;
      return true;
    }
    if (count >= max) return false;
    count += 1;
    return true;
  };
}

export function attachWebSocketServer(
  httpServer: Server,
  adminSecret: string,
  trustProxy: boolean,
  options: WsOptions
): void {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_PAYLOAD_BYTES });

  httpServer.on('upgrade', (req, socket, head) => {
    if (options.handleUpgrade?.(req, socket, head)) return;
    const match = /^\/ws\/([A-Za-z0-9_-]+)$/.exec(req.url?.split('?')[0] ?? '');
    if (!match) {
      socket.destroy();
      return;
    }
    const slug = match[1];
    wss.handleUpgrade(req, socket, head, (ws) => {
      handleConnection(ws, req, slug, adminSecret, trustProxy, options);
    });
  });
}

function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const fwd = req.headers['x-forwarded-for'];
    if (typeof fwd === 'string') return fwd.split(',')[0]?.trim() || 'unknown';
  }
  return req.socket.remoteAddress ?? 'unknown';
}

function isValidAudioChunk(data: string): boolean {
  return data.length > 0 && data.length <= MAX_AUDIO_BASE64_CHARS && data.length % 4 === 0 && BASE64_RE.test(data);
}

function normalizeViewerId(value: unknown): string {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (VIEWER_ID_RE.test(trimmed)) return trimmed;
  }
  return `anon-${crypto.randomUUID()}`;
}

function normalizeProfileText(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.replace(TEXT_CONTROL_RE, '').trim().slice(0, MAX_PROFILE_TEXT_CHARS);
}

function handleConnection(
  ws: WebSocket,
  req: IncomingMessage,
  slug: string,
  adminSecret: string,
  trustProxy: boolean,
  options: WsOptions
): void {
  const room = getOrCreateRoom(slug);
  if (!room) {
    ws.close(4404, 'unknown session');
    return;
  }

  const ip = clientIp(req, trustProxy);
  const hostThrottle = makeWindowCounter(HOST_MSG_WINDOW_MS, HOST_MSG_MAX);

  let role: 'host' | 'viewer' | null = null;
  // A viewer that presents the slug with a valid token (the /present stage) may
  // drive slides without seizing the single audio-host slot.
  let canPresent = false;

  // Require a hello within a grace period so dead sockets don't linger.
  const helloTimer = setTimeout(() => {
    if (!role) ws.close(4408, 'hello timeout');
  }, HELLO_TIMEOUT_MS);

  ws.on('message', (raw) => {
    let msg: Envelope;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.type === 'hello') {
      clearTimeout(helloTimer);
      const payload = (msg.payload ?? {}) as HelloPayload;

      if (payload.role === 'host') {
        if (isRateLimited(ip)) {
          ws.close(4429, 'rate limited');
          return;
        }
        // Trial sessions authenticate the host with their per-session token;
        // everything else requires the shared ADMIN_SECRET.
        const trial = getTrial(slug);
        const ok = trial
          ? checkAdminSecret(payload.auth, trial.hostToken)
          : checkAdminSecret(payload.auth, adminSecret);
        if (!ok) {
          recordAuthFailure(ip);
          ws.close(4401, 'unauthorized');
          return;
        }
        role = 'host';
        // Replace any stale host socket (e.g. page reload).
        if (room.host && room.host !== ws && room.host.readyState === room.host.OPEN) {
          room.host.close(4000, 'replaced by new host connection');
        }
        room.host = ws;
        ws.send(envelope('snapshot', room.nextSeq(), room.snapshotFor()));
        room.sendToHost('presence', { viewerCount: room.viewers.size });
      } else if (payload.role === 'viewer') {
        // Enforce the viewer cap configured for this room.
        if (!room.canAcceptViewer()) {
          ws.close(4409, 'viewer limit reached');
          return;
        }
        role = 'viewer';
        // Grant slide control to a viewer that supplied a valid presenter token
        // (admin secret, or the trial host token). No auth failure is recorded:
        // ordinary viewers send none and stay read-only.
        if (typeof payload.auth === 'string' && payload.auth) {
          const trial = getTrial(slug);
          canPresent = trial
            ? checkAdminSecret(payload.auth, trial.hostToken)
            : checkAdminSecret(payload.auth, adminSecret);
        }
        room.viewers.add(ws);
        room.recordViewerJoin(ws, {
          viewerId: normalizeViewerId(payload.viewerId),
          name: normalizeProfileText(payload.name),
          company: normalizeProfileText(payload.company),
        });
        ws.send(envelope('snapshot', room.nextSeq(), room.snapshotFor()));
        room.sendToHost('presence', { viewerCount: room.viewers.size });
      } else {
        ws.close(4403, 'invalid role');
      }
      return;
    }

    if (role !== 'host') {
      // The /present stage (authenticated viewer) may drive slides — only slides,
      // and only with a valid token; it never takes the audio-host slot.
      if (msg.type === 'slide.change' && canPresent) {
        if (!hostThrottle()) return;
        const { index } = (msg.payload ?? {}) as { index?: number };
        if (typeof index === 'number' && index >= 0) room.changeSlide(Math.floor(index));
        return;
      }
      // Unauthenticated viewers stay read-only: publishing presenter actions is rejected.
      if (['audio.in', 'slide.change', 'control'].includes(msg.type)) {
        ws.send(envelope('error', 0, { message: 'forbidden: viewer sockets are read-only' }));
        ws.close(4403, 'forbidden');
        return;
      }
      // Viewers CAN participate (polls/reactions).
      handleViewerMessage(room, ws, msg);
      return;
    }

    handleHostMessage(room, ws, msg, hostThrottle, options);
  });

  ws.on('close', () => {
    clearTimeout(helloTimer);
    if (role === 'viewer') {
      room.viewers.delete(ws);
      room.recordViewerLeave(ws);
      room.sendToHost('presence', { viewerCount: room.viewers.size });
    } else if (role === 'host' && room.host === ws) {
      room.host = null;
    }
  });

  ws.on('error', () => ws.close());
}

function handleHostMessage(
  room: Room,
  ws: WebSocket,
  msg: Envelope,
  throttle: () => boolean,
  options: WsOptions
): void {
  // Audio is validated and rate-shaped on its own; throttle the control plane
  // (slides, polls, control) so a flood of those can't overwhelm the room.
  if (msg.type !== 'audio.in' && !throttle()) return;

  switch (msg.type) {
    case 'audio.in': {
      const { data, clientSentAtMs } = (msg.payload ?? {}) as { data?: string; clientSentAtMs?: number };
      if (typeof data !== 'string') break;
      // A single malformed frame must NOT tear down the talk: dropping it keeps
      // the session live (a hard close here would have the client reconnect and
      // re-stream the same frame, looping forever). The size/format guard stays.
      if (!isValidAudioChunk(data)) break;
      room.handleAudioIn(data, typeof clientSentAtMs === 'number' ? clientSentAtMs : undefined);
      break;
    }
    case 'slide.change': {
      const { index } = (msg.payload ?? {}) as { index?: number };
      if (typeof index === 'number' && index >= 0) room.changeSlide(Math.floor(index));
      break;
    }
    case 'control': {
      const { action } = (msg.payload ?? {}) as { action?: string };
      // A control action that throws must not crash the message handler (and,
      // via the process-level uncaughtException handler, the whole server).
      try {
        if (action === 'start') room.start();
        else if (action === 'pause') room.pause();
        else if (action === 'stop') room.stop();
        else if (action === 'kill_gemini_test' && options.enableTestHooks) room.killGeminiForTest();
      } catch (err) {
        console.error('[ws] control action failed:', err);
      }
      break;
    }
    case 'poll.open': {
      const { question, options, correctOptions } = (msg.payload ?? {}) as {
        question?: string;
        options?: string[];
        correctOptions?: number[];
      };
      if (typeof question === 'string' && Array.isArray(options)) {
        room.openPoll(question, options.map(String), Array.isArray(correctOptions) ? correctOptions : []);
      }
      break;
    }
    case 'poll.close':
    case 'poll.pin':
    case 'poll.hide':
    case 'poll.delete': {
      const { pollId, pinned } = (msg.payload ?? {}) as { pollId?: string; pinned?: boolean };
      if (typeof pollId !== 'string') break;
      if (msg.type === 'poll.close') room.closePoll(pollId);
      else if (msg.type === 'poll.pin') room.pinPoll(pollId, pinned !== false);
      else if (msg.type === 'poll.hide') room.hidePoll(pollId);
      else room.deletePoll(pollId);
      break;
    }
  }
}

/** Viewer-allowed interactive messages (polls + reactions). */
function handleViewerMessage(room: Room, ws: WebSocket, msg: Envelope): void {
  switch (msg.type) {
    case 'poll.vote': {
      const { pollId, optionIndex } = (msg.payload ?? {}) as { pollId?: string; optionIndex?: number };
      const viewerId = room.viewerIdFor(ws);
      if (viewerId && typeof pollId === 'string' && typeof optionIndex === 'number') {
        room.votePoll(viewerId, pollId, optionIndex);
      }
      break;
    }
    case 'reaction': {
      const { emoji } = (msg.payload ?? {}) as { emoji?: string };
      if (typeof emoji === 'string') room.reaction(ws, emoji);
      break;
    }
  }
}
