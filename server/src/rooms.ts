/**
 * rooms.ts — hot realtime state, kept in process memory (spec §7: the DB is
 * the durability layer, not the realtime layer). One Room per session slug.
 */
import type { WebSocket } from 'ws';
import { GeminiBridge, type AudioSyncMetadata, type CaptionSyncMetadata } from './gemini-bridge.js';
import {
  getSessionBySlug,
  insertTranscript,
  updateSessionState,
  recordAttendeeJoin,
  addAttendeeWatch,
  setPeakViewers,
  insertPoll,
  recordPollVote,
  closePollRow,
  deletePollById,
  bumpReaction,
  type SessionRow,
} from './db.js';
import {
  envelope,
  REACTION_EMOJIS,
  type SessionState,
  type SnapshotPayload,
  type PollState,
  type AudioMarkerPayload,
  type AudioOutPayload,
  type TranscriptPayload,
} from './types.js';
import { nanoid } from 'nanoid';
import type { RealtimeAudioFanout } from './realtime-audio.js';

const RECENT_FINALS_MAX = 20; // ~10 lines per language for late-join snapshot
const PAUSE_GRACE_MS = 60_000; // keep Gemini session open ≤60s while paused
// Reaction throttle: a burst ceiling per 30s window; the 1st breach warns, a
// repeat breach triggers a 5-min cooldown. Violations decay after a calm minute.
const REACTION_WINDOW_MS = 30_000;
const REACTION_CEILING = 20;
const REACTION_COOLDOWN_MS = 5 * 60_000;
const REACTION_VIOLATION_DECAY_MS = 60_000;
const MAX_SOCKET_BUFFERED_AMOUNT = 1_000_000;
const AUDIO_SYNC_LOG_EVERY = 100;

interface RecentFinal {
  kind: 'input' | 'output';
  text: string;
  languageCode: string;
}

interface AudioSyncStats {
  micChunks: number;
  audioChunks: number;
  transcriptChunks: number;
  sfuPublishErrors: number;
  micLagMs: number[];
  fanoutLagMs: number[];
}

export class Room {
  host: WebSocket | null = null;
  viewers = new Set<WebSocket>();
  state: SessionState;
  slideIndex = 0;
  recentFinals: RecentFinal[] = [];
  bridge: GeminiBridge | null = null;
  private seq = 0;
  private startedAtMs: number | null = null;
  private pauseTimer: NodeJS.Timeout | null = null;
  // Attendance: sockets map to viewer IDs, while watch time is counted once per
  // active viewer ID so multiple tabs cannot inflate duration.
  private conns = new Map<WebSocket, { viewerId: string }>();
  private activeViewers = new Map<string, { startMs: number; sockets: number }>();
  private peakViewers = 0;
  // Interactive: one active poll at a time; votes keyed by viewerId.
  private activePoll: {
    id: string;
    question: string;
    options: string[];
    votes: Map<string, number>;
    closed: boolean;
    pinned: boolean;
    correctOptions: number[];
  } | null = null;
  // Reaction rate-limit, keyed by viewerId (persists across reconnects so a
  // cooldown can't be dodged by refreshing).
  private reactionRl = new Map<
    string,
    { times: number[]; violations: number; lastViolation: number; cooldownUntil: number }
  >();
  private audioSyncStats: AudioSyncStats = {
    micChunks: 0,
    audioChunks: 0,
    transcriptChunks: 0,
    sfuPublishErrors: 0,
    micLagMs: [],
    fanoutLagMs: [],
  };

  constructor(
    public session: SessionRow,
    private geminiApiKey: string,
    /** Cap on concurrent viewers for this server instance. */
    public readonly maxViewers: number = Infinity
  ) {
    this.state = session.state;
    this.slideIndex = 0;
    // Anchor transcript offsets to the original start so they stay monotonic
    // across pause/resume and even a server restart (started_at is in DB).
    this.peakViewers = session.peak_viewers ?? 0;
    if (session.started_at) {
      const ms = Date.parse(session.started_at.replace(' ', 'T') + 'Z');
      if (!Number.isNaN(ms)) this.startedAtMs = ms;
    }
  }

  nextSeq(): number {
    return ++this.seq;
  }

  canAcceptViewer(): boolean {
    return this.viewers.size < this.maxViewers;
  }

  // --- fan-out helpers ---

  broadcast(type: string, payload: unknown, opts: { includeHost?: boolean } = {}): void {
    const msg = envelope(type, this.nextSeq(), payload);
    for (const ws of this.viewers) {
      this.sendRaw(ws, msg);
    }
    if (opts.includeHost !== false && this.host && this.host.readyState === this.host.OPEN) {
      this.sendRaw(this.host, msg);
    }
  }

  sendToHost(type: string, payload: unknown): void {
    if (this.host && this.host.readyState === this.host.OPEN) {
      this.sendRaw(this.host, envelope(type, this.nextSeq(), payload));
    }
  }

  snapshotFor(): SnapshotPayload {
    return {
      state: this.state,
      slideIndex: this.slideIndex,
      recentTranscripts: this.recentFinals.slice(-RECENT_FINALS_MAX),
      activePoll: this.pollState(),
    };
  }

  // --- interactive: polls ---

  private pollState(): PollState | null {
    const p = this.activePoll;
    if (!p) return null;
    const counts = new Array(p.options.length).fill(0);
    for (const idx of p.votes.values()) if (idx < counts.length) counts[idx] += 1;
    return {
      id: p.id,
      question: p.question,
      options: p.options,
      counts,
      total: p.votes.size,
      closed: p.closed,
      pinned: p.pinned,
      // Quiz answers are only revealed once the poll is closed (no cheating).
      correctOptions: p.closed ? p.correctOptions : undefined,
    };
  }

  openPoll(question: string, options: string[], correctOptions: number[] = []): void {
    const q = question.trim().slice(0, 200);
    const opts = options.map((o) => o.trim().slice(0, 80)).filter(Boolean).slice(0, 6);
    if (!q || opts.length < 2) return;
    const correct = [...new Set(correctOptions)].filter((i) => i >= 0 && i < opts.length);
    const id = nanoid(8);
    this.activePoll = { id, question: q, options: opts, votes: new Map(), closed: false, pinned: false, correctOptions: correct };
    insertPoll({ session_id: this.session.id, poll_id: id, question: q, options: opts, correctOptions: correct });
    this.broadcast('poll.state', this.pollState());
  }

  votePoll(viewerId: string, pollId: string, optionIndex: number): void {
    const p = this.activePoll;
    if (!p || p.id !== pollId || p.closed) return;
    if (!Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex >= p.options.length) return;
    p.votes.set(viewerId, optionIndex);
    recordPollVote({ session_id: this.session.id, poll_id: pollId, viewer_id: viewerId, option_index: optionIndex });
    this.broadcast('poll.state', this.pollState());
  }

  closePoll(pollId: string): void {
    const p = this.activePoll;
    if (!p || p.id !== pollId) return;
    p.closed = true;
    closePollRow(this.session.id, pollId);
    this.broadcast('poll.state', this.pollState());
  }

  /** Pin/unpin a closed poll: pinned suppresses the clients' 10s auto-hide. */
  pinPoll(pollId: string, pinned: boolean): void {
    const p = this.activePoll;
    if (!p || p.id !== pollId) return;
    p.pinned = pinned;
    this.broadcast('poll.state', this.pollState());
  }

  /** Hide: remove from clients' view but keep the data (results stay in DB). */
  hidePoll(pollId: string): void {
    if (this.activePoll?.id !== pollId) return;
    this.activePoll = null;
    this.broadcast('poll.state', null);
  }

  /** Delete: remove from view AND drop the poll + its votes from the DB. */
  deletePoll(pollId: string): void {
    deletePollById(this.session.id, pollId);
    if (this.activePoll?.id === pollId) {
      this.activePoll = null;
      this.broadcast('poll.state', null);
    }
  }

  // --- interactive: reactions (Google-Meet style floating emojis) ---

  reaction(ws: WebSocket, emoji: string): void {
    if (!(REACTION_EMOJIS as readonly string[]).includes(emoji)) return;
    const viewerId = this.viewerIdFor(ws) ?? 'anon';
    const now = Date.now();
    this.evictStaleReactionRl(now);
    const rl = this.reactionRl.get(viewerId) ?? { times: [], violations: 0, lastViolation: 0, cooldownUntil: 0 };

    if (now < rl.cooldownUntil) return; // in cooldown — silently drop
    if (rl.violations > 0 && now - rl.lastViolation > REACTION_VIOLATION_DECAY_MS) rl.violations = 0;

    rl.times = rl.times.filter((t) => now - t < REACTION_WINDOW_MS);
    if (rl.times.length >= REACTION_CEILING) {
      rl.violations += 1;
      rl.lastViolation = now;
      if (rl.violations >= 2) {
        rl.cooldownUntil = now + REACTION_COOLDOWN_MS;
        this.sendTo(ws, 'reaction.cooldown', { cooldownUntil: rl.cooldownUntil });
      } else {
        this.sendTo(ws, 'reaction.warn', {});
      }
      this.reactionRl.set(viewerId, rl);
      return; // drop the offending reaction
    }
    rl.times.push(now);
    this.reactionRl.set(viewerId, rl);
    bumpReaction(this.session.id, emoji);
    this.broadcast('reaction', { emoji });
  }

  /**
   * Drop reaction-throttle entries that no longer hold live state: not in
   * cooldown, no reactions inside the current window, and violations decayed.
   * Keeps the map bounded on long, high-churn sessions (entries are keyed by
   * viewerId and otherwise persist across reconnects).
   */
  private evictStaleReactionRl(now: number): void {
    for (const [viewerId, rl] of this.reactionRl) {
      const inCooldown = now < rl.cooldownUntil;
      const hasRecent = rl.times.some((t) => now - t < REACTION_WINDOW_MS);
      const violationsLive = rl.violations > 0 && now - rl.lastViolation <= REACTION_VIOLATION_DECAY_MS;
      if (!inCooldown && !hasRecent && !violationsLive) this.reactionRl.delete(viewerId);
    }
  }

  private sendTo(ws: WebSocket, type: string, payload: unknown): void {
    this.sendRaw(ws, envelope(type, this.nextSeq(), payload));
  }

  private sendRaw(ws: WebSocket, msg: string): void {
    if (ws.readyState !== ws.OPEN) return;
    if (ws.bufferedAmount > MAX_SOCKET_BUFFERED_AMOUNT) {
      ws.close(1013, 'client too slow');
      return;
    }
    ws.send(msg);
  }

  // --- session lifecycle (admin-only actions; auth enforced in ws.ts) ---

  start(): void {
    // Start works from created, paused, OR ended — resuming an ended talk
    // reopens a Gemini session and continues with the same transcript/slide
    // history (recentFinals + DB persist; offsets stay anchored to the start).
    const resuming = this.state === 'ended';
    this.clearPauseTimer();
    void audioFanout?.startSession(this.session.slug).catch((err) => {
      console.error(`[rooms] audio fanout failed to start for ${this.session.slug}:`, err);
    });
    if (!this.bridge) {
      this.bridge = this.createBridge();
      void this.bridge.start();
    }
    if (this.startedAtMs === null) this.startedAtMs = Date.now();
    this.setState('live', { markStarted: true, clearEnded: resuming });
  }

  pause(): void {
    if (this.state !== 'live') return;
    this.setState('paused');
    // Keep the Gemini session warm briefly so resume is instant, then close
    // it to stop burning session time (spec §6: kept open ≤60s).
    this.clearPauseTimer();
    this.pauseTimer = setTimeout(() => {
      this.bridge?.close();
      this.bridge = null;
    }, PAUSE_GRACE_MS);
  }

  stop(): void {
    if (this.state === 'ended') return;
    this.clearPauseTimer();
    this.bridge?.close();
    this.bridge = null;
    void audioFanout?.close(this.session.slug);
    // Flush in-progress watch time so post-session analytics are complete even
    // for viewers still connected at stop; reset their clocks to avoid double count.
    this.flushWatchTime();
    this.setState('ended', { markEnded: true });
  }

  changeSlide(index: number): void {
    this.slideIndex = index;
    this.broadcast('slide.change', { index });
  }

  // --- attendance ---

  recordViewerJoin(ws: WebSocket, info: { viewerId: string; name: string; company: string }): void {
    const now = Date.now();
    this.conns.set(ws, { viewerId: info.viewerId });
    const active = this.activeViewers.get(info.viewerId);
    if (active) {
      active.sockets += 1;
    } else {
      this.activeViewers.set(info.viewerId, { startMs: now, sockets: 1 });
    }
    recordAttendeeJoin({
      session_id: this.session.id,
      viewer_id: info.viewerId,
      name: info.name,
      company: info.company,
    });
    if (this.activeViewerCount > this.peakViewers) {
      this.peakViewers = this.activeViewerCount;
      setPeakViewers(this.session.id, this.peakViewers);
    }
  }

  recordViewerLeave(ws: WebSocket): void {
    const c = this.conns.get(ws);
    if (!c) return;
    this.conns.delete(ws);
    const active = this.activeViewers.get(c.viewerId);
    if (!active) return;
    active.sockets -= 1;
    if (active.sockets <= 0) {
      addAttendeeWatch(this.session.id, c.viewerId, Date.now() - active.startMs);
      this.activeViewers.delete(c.viewerId);
    }
  }

  /** viewerId for a connected viewer socket (for vote dedup). */
  viewerIdFor(ws: WebSocket): string | undefined {
    return this.conns.get(ws)?.viewerId;
  }

  private flushWatchTime(): void {
    const now = Date.now();
    for (const [viewerId, active] of this.activeViewers) {
      addAttendeeWatch(this.session.id, viewerId, now - active.startMs);
      active.startMs = now;
    }
  }

  /** In-progress watch ms per viewerId (not yet persisted) for live analytics. */
  activeWatchMs(): Map<string, number> {
    const now = Date.now();
    const m = new Map<string, number>();
    for (const [viewerId, active] of this.activeViewers) {
      m.set(viewerId, now - active.startMs);
    }
    return m;
  }

  get activeViewerCount(): number {
    return this.activeViewers.size;
  }

  get peak(): number {
    return this.peakViewers;
  }

  handleAudioIn(base64: string, clientSentAtMs?: number): void {
    if (this.state !== 'live') return;
    if (audioSyncMetadata && clientSentAtMs !== undefined) this.recordMicSync(clientSentAtMs);
    this.bridge?.sendAudio(base64);
  }

  killGeminiForTest(): void {
    this.bridge?.killForTest();
  }

  private setState(
    state: Exclude<SessionState, 'reconnecting'>,
    opts: { markStarted?: boolean; markEnded?: boolean; clearEnded?: boolean } = {}
  ): void {
    this.state = state;
    updateSessionState(this.session.id, state, opts);
    this.broadcast('session.state', { state });
  }

  private clearPauseTimer(): void {
    if (this.pauseTimer) {
      clearTimeout(this.pauseTimer);
      this.pauseTimer = null;
    }
  }

  private offsetMs(): number {
    return this.startedAtMs ? Date.now() - this.startedAtMs : 0;
  }

  private createBridge(): GeminiBridge {
    return new GeminiBridge(
      this.geminiApiKey,
      this.session.target_lang,
      this.session.echo_target_language === 1,
      {
        onAudio: (data, metadata) => {
          const serverSentAtMs = Date.now();
          const audioPayload: AudioOutPayload = {
            data,
            track: 'translated',
            ...(metadata && audioSyncMetadata
              ? {
                  streamId: metadata.streamId,
                  audioSeq: metadata.audioSeq,
                  audioStartMs: metadata.audioStartMs,
                  durationMs: metadata.durationMs,
                  serverSentAtMs,
                }
              : {}),
          };
          // Runs inside the Gemini SDK callback; a throw here would surface as an
          // uncaughtException (→ server shutdown), so isolate the fanout path.
          try {
            audioFanout?.publishTranslated(
              this.session.slug,
              data,
              metadata && audioSyncMetadata
                ? {
                    track: 'translated',
                    streamId: metadata.streamId,
                    audioSeq: metadata.audioSeq,
                    audioStartMs: metadata.audioStartMs,
                    durationMs: metadata.durationMs,
                    onSent: (marker: AudioMarkerPayload) => {
                      this.broadcast('audio.marker', marker);
                      this.recordAudioSync(metadata, marker.serverSentAtMs);
                    },
                  }
                : undefined
            );
          } catch (err) {
            this.audioSyncStats.sfuPublishErrors += 1;
            console.error(`[rooms] audio fanout publish failed for ${this.session.slug}:`, err);
          }
          // Keep the host PA/monitor path on the app WS; viewer fanout is SFU.
          this.sendToHost('audio.out', audioPayload);
        },
        onTranscript: (kind, text, isFinal, languageCode, metadata) => {
          const serverSentAtMs = Date.now();
          const payload: TranscriptPayload = {
            text,
            isFinal,
            languageCode,
            ...(kind === 'output' && metadata && audioSyncMetadata
              ? {
                  streamId: metadata.streamId,
                  captionSeq: metadata.captionSeq,
                  captionAudioOffsetMs: metadata.captionAudioOffsetMs,
                  serverSentAtMs,
                }
              : {}),
          };
          if (kind === 'output' && metadata && audioSyncMetadata) this.recordCaptionSync(metadata);
          this.broadcast(kind === 'input' ? 'transcript.input' : 'transcript.output', payload);
        },
        onFinalSegment: (kind, text, languageCode) => {
          this.recentFinals.push({ kind, text, languageCode });
          if (this.recentFinals.length > RECENT_FINALS_MAX * 2) {
            this.recentFinals.splice(0, this.recentFinals.length - RECENT_FINALS_MAX);
          }
          // Persist only final segments; partials are ephemeral over WS (§7).
          insertTranscript({
            session_id: this.session.id,
            kind,
            language_code: languageCode,
            text,
            t_offset_ms: this.offsetMs(),
            slide_index: this.slideIndex,
          });
        },
        onStatus: (status, reason) => {
          if (status === 'reconnecting' && this.state === 'live') {
            this.broadcast('session.state', { state: 'reconnecting' });
          } else if (status === 'connected' && this.state === 'live') {
            this.broadcast('session.state', { state: 'live' });
          } else if (status === 'failed') {
            // Translation gave up — surface it instead of an opaque reconnect
            // spinner. The session stays 'live' so captions/slides still work.
            this.broadcast('session.error', {
              scope: 'translation',
              message: reason || 'translation unavailable',
            });
          }
        },
      },
      audioSyncMetadata
    );
  }

  private recordAudioSync(metadata: AudioSyncMetadata, serverSentAtMs: number): void {
    this.audioSyncStats.audioChunks += 1;
    this.audioSyncStats.fanoutLagMs.push(Math.max(0, serverSentAtMs - metadata.geminiReceivedAtMs));
    if (this.audioSyncStats.fanoutLagMs.length > AUDIO_SYNC_LOG_EVERY) this.audioSyncStats.fanoutLagMs.shift();
    this.maybeLogAudioSyncStats();
  }

  private recordMicSync(clientSentAtMs: number): void {
    this.audioSyncStats.micChunks += 1;
    this.audioSyncStats.micLagMs.push(Math.max(0, Date.now() - clientSentAtMs));
    if (this.audioSyncStats.micLagMs.length > AUDIO_SYNC_LOG_EVERY) this.audioSyncStats.micLagMs.shift();
    this.maybeLogAudioSyncStats();
  }

  private recordCaptionSync(_metadata: CaptionSyncMetadata): void {
    this.audioSyncStats.transcriptChunks += 1;
    this.maybeLogAudioSyncStats();
  }

  private maybeLogAudioSyncStats(): void {
    const total =
      this.audioSyncStats.micChunks +
      this.audioSyncStats.audioChunks +
      this.audioSyncStats.transcriptChunks;
    if (total === 0 || total % AUDIO_SYNC_LOG_EVERY !== 0) return;
    const lag = [...this.audioSyncStats.fanoutLagMs].sort((a, b) => a - b);
    const micLag = [...this.audioSyncStats.micLagMs].sort((a, b) => a - b);
    const pct = (p: number) => lag.length ? lag[Math.min(lag.length - 1, Math.floor((lag.length - 1) * p))] : 0;
    const micPct = (p: number) =>
      micLag.length ? micLag[Math.min(micLag.length - 1, Math.floor((micLag.length - 1) * p))] : 0;
    console.log(
      `[audio-sync] slug=${this.session.slug} micChunks=${this.audioSyncStats.micChunks} ` +
        `audioChunks=${this.audioSyncStats.audioChunks} ` +
        `captionChunks=${this.audioSyncStats.transcriptChunks} fanoutLagP50Ms=${Math.round(pct(0.5))} ` +
        `fanoutLagP95Ms=${Math.round(pct(0.95))} micLagP50Ms=${Math.round(micPct(0.5))} ` +
        `micLagP95Ms=${Math.round(micPct(0.95))} sfuPublishErrors=${this.audioSyncStats.sfuPublishErrors} ` +
        `sfuQueueMs=${audioFanout?.queueDepthMs(this.session.slug) ?? 0}`
    );
  }
}

// --- registry ---

const rooms = new Map<string, Room>();
let geminiApiKey = '';
let defaultMaxViewers = Infinity;
let audioFanout: RealtimeAudioFanout | null = null;
let audioSyncMetadata = false;

export function configureRooms(
  apiKey: string,
  maxViewersPerSession: number = Infinity,
  realtimeAudioFanout: RealtimeAudioFanout | null = null,
  opts: { audioSyncMetadata?: boolean } = {}
): void {
  geminiApiKey = apiKey;
  defaultMaxViewers = maxViewersPerSession;
  audioFanout = realtimeAudioFanout;
  audioSyncMetadata = opts.audioSyncMetadata === true;
}

export function getOrCreateRoom(slug: string): Room | undefined {
  let room = rooms.get(slug);
  if (!room) {
    const session = getSessionBySlug(slug);
    if (!session) return undefined;
    room = new Room(session, geminiApiKey, defaultMaxViewers);
    rooms.set(slug, room);
  }
  return room;
}

export function getRoom(slug: string): Room | undefined {
  return rooms.get(slug);
}

function teardownRoom(slug: string, code = 4001, reason = 'session deleted'): void {
  const room = rooms.get(slug);
  if (!room) return;
  room.bridge?.close();
  room.bridge = null;
  void audioFanout?.close(slug);
  room.host?.close(code, reason);
  for (const v of room.viewers) v.close(code, reason);
  rooms.delete(slug);
}

/** Tear down a room (on session delete): stop Gemini, drop all sockets. */
export function deleteRoom(slug: string): void {
  teardownRoom(slug);
}

/** Process shutdown: close bridges and notify sockets. */
export function closeAllRooms(): void {
  for (const slug of [...rooms.keys()]) {
    teardownRoom(slug, 1012, 'server shutting down');
  }
  audioFanout?.closeAll();
}
