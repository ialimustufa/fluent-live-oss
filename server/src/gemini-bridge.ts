/**
 * gemini-bridge.ts — ALL Gemini interaction lives in this module (spec §10:
 * the model is in public preview; isolate it so it's swappable).
 *
 * One GeminiBridge per live presentation. It owns:
 *  - the Live API session lifecycle (connect / reconnect / proactive rotation)
 *  - demuxing server messages into audio chunks + input/output transcripts
 *  - transcript segmentation (partials stream out; finals are committed on
 *    turn completion or a short idle gap)
 *  - a mic-audio ring buffer so up to 10 s of speech survives a reconnect.
 */
import { GoogleGenAI, type Session, type LiveServerMessage, Modality } from '@google/genai';
import { nanoid } from 'nanoid';
import { pcm16Base64DurationMs } from './audio-timing.js';

export const LIVE_TRANSLATE_MODEL = 'gemini-3.5-live-translate-preview';
const RECONNECT_DELAY_MS = 2_000;
const RECONNECT_DELAY_MAX_MS = 30_000;
// After this many consecutive failed (re)connects we stop retrying and surface
// a 'failed' status, rather than looping silently forever.
const MAX_CONSECUTIVE_FAILURES = 6;
const BUFFER_MAX_MS = 10_000;
const CHUNK_MS = 100; // admin sends ~100ms frames
const BUFFER_MAX_CHUNKS = BUFFER_MAX_MS / CHUNK_MS;
const SEGMENT_IDLE_MS = 2_500; // finalize a transcript segment after this much silence
// Live API sessions have a server-side time limit; rotate proactively before
// we hit it rather than waiting for the server to drop us mid-sentence.
const SESSION_ROTATE_MS = 9 * 60_000;

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export interface BridgeEvents {
  onAudio: (base64Pcm24k: string, metadata?: AudioSyncMetadata) => void;
  onTranscript: (
    kind: 'input' | 'output',
    text: string,
    isFinal: boolean,
    languageCode: string,
    metadata?: CaptionSyncMetadata
  ) => void;
  /** Final segments only — for persistence. */
  onFinalSegment: (kind: 'input' | 'output', text: string, languageCode: string) => void;
  /** 'failed' is terminal: translation gave up (bad key/model or repeated drops). */
  onStatus: (status: 'connected' | 'reconnecting' | 'closed' | 'failed', reason?: string) => void;
}

export interface AudioSyncMetadata {
  streamId: string;
  audioSeq: number;
  audioStartMs: number;
  durationMs: number;
  geminiReceivedAtMs: number;
}

export interface CaptionSyncMetadata {
  streamId: string;
  captionSeq: number;
  captionAudioOffsetMs: number;
  geminiReceivedAtMs: number;
}

interface SegmentState {
  text: string;
  languageCode: string;
  idleTimer: NodeJS.Timeout | null;
}

export class GeminiBridge {
  private ai: GoogleGenAI;
  private session: Session | null = null;
  private closed = false;
  private connecting = false;
  private setupComplete = false;
  private consecutiveFailures = 0;
  private audioBuffer: string[] = [];
  private rotateTimer: NodeJS.Timeout | null = null;
  private segments: Record<'input' | 'output', SegmentState>;
  private streamId = nanoid(12);
  private audioSeq = 0;
  private captionSeq = 0;
  private audioTimelineMs = 0;

  constructor(
    apiKey: string,
    private targetLanguageCode: string,
    private echoTargetLanguage: boolean,
    private events: BridgeEvents,
    private audioSyncMetadata = false
  ) {
    this.ai = new GoogleGenAI({ apiKey });
    this.segments = {
      input: { text: '', languageCode: 'en', idleTimer: null },
      output: { text: '', languageCode: targetLanguageCode, idleTimer: null },
    };
  }

  async start(): Promise<void> {
    this.closed = false;
    await this.connect();
  }

  private async connect(): Promise<void> {
    if (this.closed || this.connecting) return;
    this.connecting = true;
    this.setupComplete = false;
    this.resetSyncStream();
    try {
      this.session = await this.ai.live.connect({
        model: LIVE_TRANSLATE_MODEL,
        // translationConfig is specific to the live-translate model and not
        // yet in the SDK's LiveConnectConfig type — pass it through untyped.
        // @google/genai >= 2.x has translationConfig as a first-class
        // LiveConnectConfig field and maps it to setup.generationConfig.translationConfig,
        // while the transcription configs go to the top level of setup — exactly
        // matching Google's live-translate sample. (1.x had no translationConfig
        // mapping and silently dropped it, which is why translation never ran.)
        config: {
          responseModalities: [Modality.AUDIO],
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          translationConfig: {
            targetLanguageCode: this.targetLanguageCode,
            echoTargetLanguage: this.echoTargetLanguage,
          },
        },
        callbacks: {
          onopen: () => {
            console.log(
              `[gemini-bridge] socket opened — waiting for setupComplete ` +
                `(model=${LIVE_TRANSLATE_MODEL}, targetLanguageCode=${this.targetLanguageCode})`
            );
          },
          onmessage: (msg: LiveServerMessage) => this.handleMessage(msg),
          onerror: (e: ErrorEvent) => {
            console.error('[gemini-bridge] socket error:', e?.message ?? e);
          },
          onclose: (e?: CloseEvent) => {
            const wasSetupComplete = this.setupComplete;
            // Setup rejections (e.g. a bad config or unsupported model) usually
            // surface here as a non-1000 close with a reason — log it so we're
            // not flying blind.
            if (e && e.code !== 1000) {
              console.error(
                `[gemini-bridge] socket closed code=${e.code} reason=${e.reason || '(none)'} ` +
                  `(model=${LIVE_TRANSLATE_MODEL}, targetLanguageCode=${this.targetLanguageCode})`
              );
            }
            this.session = null;
            this.setupComplete = false;
            if (e?.code === 1007 && !wasSetupComplete) {
              console.error(
                '[gemini-bridge] setup was rejected by Gemini. Check that the Live Translate ' +
                  'model is available for this API key and that targetLanguageCode is supported.'
              );
              this.fail('translation setup was rejected by Gemini');
              return;
            }
            if (!this.closed) this.scheduleReconnect(e?.reason || `closed (code ${e?.code ?? 'n/a'})`);
          },
        },
      });
    } catch (err) {
      console.error(`[gemini-bridge] connect failed: ${describeError(err)}`);
      if (!this.closed) this.scheduleReconnect(describeError(err));
    } finally {
      this.connecting = false;
    }
  }

  /** Terminal failure: stop retrying and tell listeners why. */
  private fail(reason: string): void {
    this.closed = true;
    if (this.rotateTimer) clearTimeout(this.rotateTimer);
    this.events.onStatus('failed', reason);
  }

  private scheduleReconnect(reason: string): void {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures > MAX_CONSECUTIVE_FAILURES) {
      console.error(
        `[gemini-bridge] giving up after ${MAX_CONSECUTIVE_FAILURES} failed reconnects: ${reason}`
      );
      this.fail(reason);
      return;
    }
    this.events.onStatus('reconnecting', reason);
    if (this.rotateTimer) clearTimeout(this.rotateTimer);
    // Capped exponential backoff so a persistently-failing connect doesn't
    // hammer Gemini every 2s forever.
    const delay = Math.min(RECONNECT_DELAY_MS * 2 ** (this.consecutiveFailures - 1), RECONNECT_DELAY_MAX_MS);
    setTimeout(() => void this.connect(), delay);
  }

  private scheduleRotation(): void {
    if (this.rotateTimer) clearTimeout(this.rotateTimer);
    this.rotateTimer = setTimeout(() => {
      if (this.closed) return;
      // Proactive rotation: close the current session; onclose triggers the
      // normal reconnect path, and the mic buffer covers the ~2s gap.
      console.log('[gemini-bridge] rotating session before server time limit');
      this.session?.close();
    }, SESSION_ROTATE_MS);
    this.rotateTimer.unref?.();
  }

  /** Test hook for acceptance criterion #4: kill the Gemini WS mid-talk. */
  killForTest(): void {
    console.log('[gemini-bridge] test hook: killing Gemini WS');
    this.session?.close();
  }

  sendAudio(base64Pcm16k: string): void {
    if (this.session && this.setupComplete) {
      try {
        this.session.sendRealtimeInput({
          audio: { data: base64Pcm16k, mimeType: 'audio/pcm;rate=16000' },
        });
        return;
      } catch (err) {
        console.error(`[gemini-bridge] send failed, buffering: ${describeError(err)}`);
      }
    }
    this.audioBuffer.push(base64Pcm16k);
    if (this.audioBuffer.length > BUFFER_MAX_CHUNKS) {
      this.audioBuffer.splice(0, this.audioBuffer.length - BUFFER_MAX_CHUNKS);
    }
  }

  private flushBuffer(): void {
    const buffered = this.audioBuffer;
    this.audioBuffer = [];
    for (const chunk of buffered) this.sendAudio(chunk);
  }

  private handleMessage(msg: LiveServerMessage): void {
    // Positive confirmation that the translate session was accepted with our
    // config — if this never logs, the setup was rejected.
    if ((msg as unknown as { setupComplete?: unknown }).setupComplete) {
      this.setupComplete = true;
      this.consecutiveFailures = 0; // a clean connection resets the backoff/give-up
      console.log(
        `[gemini-bridge] setup complete — translating to ${this.targetLanguageCode}` +
          ` (echoTargetLanguage=${this.echoTargetLanguage})`
      );
      this.events.onStatus('connected');
      this.flushBuffer();
      this.scheduleRotation();
    }

    const sc = msg.serverContent;
    if (!sc) return;

    const scAny = sc as unknown as {
      inputTranscription?: { text?: string; languageCode?: string; finished?: boolean };
      outputTranscription?: { text?: string; languageCode?: string; finished?: boolean };
      turnComplete?: boolean;
      modelTurn?: { parts?: { inlineData?: { data?: string; mimeType?: string } }[] };
    };

    if (scAny.inputTranscription?.text) {
      this.appendTranscript(
        'input',
        scAny.inputTranscription.text,
        scAny.inputTranscription.languageCode ?? 'en',
        scAny.inputTranscription.finished === true
      );
    }
    if (scAny.outputTranscription?.text) {
      this.appendTranscript(
        'output',
        scAny.outputTranscription.text,
        scAny.outputTranscription.languageCode ?? this.targetLanguageCode,
        scAny.outputTranscription.finished === true
      );
    }

    for (const part of scAny.modelTurn?.parts ?? []) {
      const data = part.inlineData?.data;
      if (data) this.emitAudio(data);
    }

    if (scAny.turnComplete) {
      this.finalizeSegment('input');
      this.finalizeSegment('output');
    }
  }

  private appendTranscript(
    kind: 'input' | 'output',
    text: string,
    languageCode: string,
    finished: boolean
  ): void {
    const seg = this.segments[kind];
    seg.text += text;
    seg.languageCode = languageCode;
    this.events.onTranscript(kind, seg.text, false, languageCode, this.captionMetadata(kind));

    if (finished) {
      this.finalizeSegment(kind);
      return;
    }
    // Translation mode is a continuous interpreter — turnComplete may never
    // arrive, so an idle gap also closes out a segment.
    if (seg.idleTimer) clearTimeout(seg.idleTimer);
    seg.idleTimer = setTimeout(() => this.finalizeSegment(kind), SEGMENT_IDLE_MS);
  }

  private finalizeSegment(kind: 'input' | 'output'): void {
    const seg = this.segments[kind];
    if (seg.idleTimer) {
      clearTimeout(seg.idleTimer);
      seg.idleTimer = null;
    }
    const text = seg.text.trim();
    if (!text) return;
    seg.text = '';
    this.events.onTranscript(kind, text, true, seg.languageCode, this.captionMetadata(kind));
    this.events.onFinalSegment(kind, text, seg.languageCode);
  }

  private resetSyncStream(): void {
    this.streamId = nanoid(12);
    this.audioSeq = 0;
    this.captionSeq = 0;
    this.audioTimelineMs = 0;
  }

  private emitAudio(base64Pcm24k: string): void {
    if (!this.audioSyncMetadata) {
      this.events.onAudio(base64Pcm24k);
      return;
    }
    const durationMs = pcm16Base64DurationMs(base64Pcm24k);
    const metadata: AudioSyncMetadata = {
      streamId: this.streamId,
      audioSeq: ++this.audioSeq,
      audioStartMs: this.audioTimelineMs,
      durationMs,
      geminiReceivedAtMs: Date.now(),
    };
    this.audioTimelineMs += durationMs;
    this.events.onAudio(base64Pcm24k, metadata);
  }

  private captionMetadata(kind: 'input' | 'output'): CaptionSyncMetadata | undefined {
    if (!this.audioSyncMetadata || kind !== 'output') return undefined;
    return {
      streamId: this.streamId,
      captionSeq: ++this.captionSeq,
      captionAudioOffsetMs: this.audioTimelineMs,
      geminiReceivedAtMs: Date.now(),
    };
  }

  close(): void {
    this.closed = true;
    if (this.rotateTimer) clearTimeout(this.rotateTimer);
    this.finalizeSegment('input');
    this.finalizeSegment('output');
    this.session?.close();
    this.session = null;
    this.audioBuffer = [];
    this.events.onStatus('closed');
  }
}
