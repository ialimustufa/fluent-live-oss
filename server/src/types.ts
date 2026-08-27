/**
 * WS protocol: JSON envelope {type, ts, seq, payload} on one namespace per slug.
 */
export type SessionState = 'created' | 'live' | 'paused' | 'ended' | 'reconnecting';

export interface Envelope<T = unknown> {
  type: string;
  ts: number;
  seq: number;
  payload: T;
}

// Admin → server
export interface AudioInPayload {
  data: string; // base64 16kHz mono 16-bit PCM, ~100ms chunks
  clientSentAtMs?: number;
}
export interface SlideChangePayload {
  index: number;
}
export interface ControlPayload {
  action: 'start' | 'pause' | 'stop' | 'kill_gemini_test';
}
export interface HelloPayload {
  role: 'host' | 'viewer';
  auth?: string; // ADMIN_SECRET for host sockets — handshake message, never a URL param
  // Viewer onboarding analytics. viewerId is a stable browser id so
  // reconnects/refreshes dedupe to one attendee. name/company are optional.
  viewerId?: string;
  name?: string;
  company?: string;
}

// Server → clients
export interface AudioOutPayload {
  data: string; // base64 24kHz mono 16-bit PCM
  track: 'translated' | 'source'; // 'source' reserved for v2 raw-audio relay
  streamId?: string;
  audioSeq?: number;
  audioStartMs?: number;
  durationMs?: number;
  serverSentAtMs?: number;
}
export interface AudioMarkerPayload {
  track: 'translated' | 'source';
  streamId: string;
  audioSeq: number;
  audioStartMs: number;
  durationMs: number;
  serverSentAtMs: number;
  publisherGeneration?: number;
  sfuSentAtMs?: number;
  sfuQueueMs?: number;
}
export interface TranscriptPayload {
  text: string;
  isFinal: boolean;
  languageCode: string;
  streamId?: string;
  captionSeq?: number;
  captionAudioOffsetMs?: number;
  serverSentAtMs?: number;
}
export interface SessionStatePayload {
  state: SessionState;
}
export interface PresencePayload {
  viewerCount: number;
}
export interface PollState {
  id: string;
  question: string;
  options: string[];
  counts: number[];
  total: number;
  closed: boolean;
  pinned: boolean; // host kept it on screen after close (suppresses 10s auto-hide)
  correctOptions?: number[]; // quiz answer(s); only revealed once closed
}
export interface SnapshotPayload {
  state: SessionState;
  slideIndex: number;
  recentTranscripts: {
    kind: 'input' | 'output';
    text: string;
    languageCode: string;
  }[];
  activePoll: PollState | null;
}

// --- Interactive layer (polls + reactions) ---
// viewer → server
export interface PollVotePayload {
  pollId: string;
  optionIndex: number;
}
export interface ReactionPayload {
  emoji: string;
}
// host → server
export interface PollOpenPayload {
  question: string;
  options: string[];
  correctOptions?: number[];
}
export interface PollActionPayload {
  pollId: string; // poll.close / poll.pin / poll.hide / poll.delete
  pinned?: boolean; // for poll.pin
}
// server → a single viewer (reaction throttling)
export interface ReactionLimitPayload {
  cooldownUntil?: number; // epoch ms; present on reaction.cooldown
}
// Allowed reaction emojis (Google-Meet style floating reactions).
export const REACTION_EMOJIS = ['👍', '❤️', '🎉', '👏', '😮', '😂'] as const;

export function envelope<T>(type: string, seq: number, payload: T): string {
  return JSON.stringify({ type, ts: Date.now(), seq, payload } satisfies Envelope<T>);
}
