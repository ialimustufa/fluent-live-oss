/**
 * Viewer playback: jitter-buffered 24 kHz PCM scheduled via AudioBufferSource,
 * targeting low latency. With AUDIO_SYNC_V2 enabled, the scheduler preserves
 * complete translated audio and reports backlog instead of skipping mid-phrase.
 *
 * Cross-browser / iOS notes (this path is the fragile one on mobile):
 *  - DON'T force the AudioContext sample rate. iOS Safari ignores/breaks on an
 *    arbitrary rate; we let it run at the hardware rate and create 24 kHz
 *    buffers (Web Audio resamples them to the context rate automatically).
 *  - Use webkitAudioContext as a fallback for older Safari.
 *  - Route gain → MediaStreamAudioDestinationNode → a hidden <audio playsinline>
 *    element. Playing through a media element uses iOS's "playback" audio
 *    session, so audio comes out even when the ring/silent switch is ON (raw
 *    AudioContext output is muted by that switch). It also gives us broad
 *    HTMLMediaElement.setSinkId support for device selection.
 *  - Unlock on the user gesture: resume() + play() + a 1-frame silent buffer.
 */
import { AUDIO_SYNC_V2, audioSyncDebug, type AudioTimingMetadata } from './audio-sync';

const SAMPLE_RATE = 24000;
const LEGACY_JITTER_TARGET_S = 0.25;
const LEGACY_MAX_LAG_S = 2.0;
const SYNC_JITTER_TARGET_S = 0.35;
const NORMAL_BACKLOG_S = 4.0;
const EMERGENCY_BACKLOG_S = 8.0;

type AnyWindow = typeof window & { webkitAudioContext?: typeof AudioContext };
type SinkEl = HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };

export interface PlaybackSchedule {
  accepted: boolean;
  streamId?: string;
  audioSeq?: number;
  audioStartMs?: number;
  durationMs?: number;
  localStartTimeMs?: number;
  localEndTimeMs?: number;
  backlogMs: number;
  dropped: boolean;
  emergencyBacklog: boolean;
  underrun: boolean;
}

interface ScheduledChunk {
  src: AudioBufferSourceNode;
  streamId?: string;
  audioSeq?: number;
  audioStartMs?: number;
  durationMs?: number;
  localStartTime: number;
  localEndTime: number;
}

export class TranslatedAudioPlayer {
  private ctx: AudioContext | null = null;
  private gain: GainNode | null = null;
  private el: SinkEl | null = null; // media-element sink (iOS-friendly)
  private playhead = 0; // ctx.currentTime-based scheduling cursor
  private _volume = 1;
  private _muted = false;
  private scheduled: ScheduledChunk[] = [];

  /** Must be called from a user gesture (the unmute tap). */
  async enable(): Promise<void> {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      await this.el?.play().catch(() => {});
      return;
    }

    const Ctor = (window as AnyWindow).AudioContext ?? (window as AnyWindow).webkitAudioContext;
    this.ctx = new Ctor(); // no forced sampleRate — iOS-safe
    this.gain = this.ctx.createGain();

    // Preferred output: media element (defeats the iOS silent switch). Fall
    // back to the raw context destination if anything here is unsupported.
    try {
      const dest = this.ctx.createMediaStreamDestination();
      this.gain.connect(dest);
      const el = new Audio() as SinkEl;
      el.srcObject = dest.stream;
      el.autoplay = true;
      el.setAttribute('playsinline', '');
      el.setAttribute('webkit-playsinline', '');
      el.style.display = 'none';
      document.body.appendChild(el);
      this.el = el;
    } catch {
      this.gain.connect(this.ctx.destination);
      this.el = null;
    }

    this.applyGain();
    await this.ctx.resume();
    await this.el?.play().catch(() => {});
    this.unlockSilentBuffer();
  }

  /** Play one silent frame to fully unlock audio on iOS within the gesture. */
  private unlockSilentBuffer(): void {
    if (!this.ctx || !this.gain) return;
    const buf = this.ctx.createBuffer(1, 1, this.ctx.sampleRate);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.gain);
    src.start(0);
  }

  get enabled(): boolean {
    return this.ctx !== null && this.ctx.state === 'running';
  }

  /** True while audio is scheduled to be playing right now — drives the
   *  host's half-duplex mic gate in Room mode. */
  isPlaying(): boolean {
    if (!this.ctx) return false;
    return this.playhead > this.ctx.currentTime + 0.02;
  }

  /** Route output to a specific device. Prefers the media element (broad
   *  support); falls back to AudioContext.setSinkId (Chromium). */
  async setSink(deviceId: string): Promise<boolean> {
    try {
      if (this.el?.setSinkId) {
        await this.el.setSinkId(deviceId);
        return true;
      }
      const ctx = this.ctx as (AudioContext & { setSinkId?: (id: string) => Promise<void> }) | null;
      if (ctx?.setSinkId) {
        await ctx.setSinkId(deviceId);
        return true;
      }
    } catch {
      /* device unavailable / unsupported */
    }
    return false;
  }

  pushChunk(base64Pcm24k: string, timing: AudioTimingMetadata = {}): PlaybackSchedule {
    if (!this.ctx || !this.gain) {
      return {
        accepted: false,
        backlogMs: 0,
        dropped: false,
        emergencyBacklog: false,
        underrun: false,
      };
    }
    // iOS may auto-suspend the context (backgrounding); nudge it back.
    if (this.ctx.state === 'suspended') {
      void this.ctx.resume();
      void this.el?.play().catch(() => {});
    }

    const bin = atob(base64Pcm24k);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const samples = new Int16Array(bytes.buffer, 0, Math.floor(bytes.length / 2));
    if (samples.length === 0) {
      return {
        accepted: false,
        streamId: timing.streamId,
        audioSeq: timing.audioSeq,
        audioStartMs: timing.audioStartMs,
        durationMs: timing.durationMs,
        backlogMs: Math.max(0, (this.playhead - this.ctx.currentTime) * 1000),
        dropped: false,
        emergencyBacklog: false,
        underrun: false,
      };
    }

    const floats = new Float32Array(samples.length);
    for (let i = 0; i < samples.length; i++) floats[i] = samples[i] / 0x8000;

    // Buffer is tagged 24 kHz; Web Audio resamples to the context rate on play.
    const buffer = this.ctx.createBuffer(1, floats.length, SAMPLE_RATE);
    buffer.copyToChannel(floats, 0);

    const now = this.ctx.currentTime;
    const target = AUDIO_SYNC_V2 ? SYNC_JITTER_TARGET_S : LEGACY_JITTER_TARGET_S;
    const underrun = this.playhead < now + target;
    let dropped = false;
    if (underrun) {
      // Buffer drained (or first chunk): restart the cursor with jitter margin.
      this.playhead = now + target;
    } else if (!AUDIO_SYNC_V2 && this.playhead > now + LEGACY_MAX_LAG_S) {
      // We've fallen too far behind live — skip ahead.
      this.playhead = now + target;
      dropped = true;
    }

    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.gain);
    const localStartTime = this.playhead;
    const localEndTime = localStartTime + buffer.duration;
    src.start(localStartTime);
    this.playhead += buffer.duration;
    const scheduled: ScheduledChunk = {
      src,
      streamId: timing.streamId,
      audioSeq: timing.audioSeq,
      audioStartMs: timing.audioStartMs,
      durationMs: timing.durationMs ?? Math.round(buffer.duration * 1000),
      localStartTime,
      localEndTime,
    };
    this.scheduled.push(scheduled);
    src.onended = () => {
      this.scheduled = this.scheduled.filter((item) => item.src !== src);
    };

    const backlogMs = Math.max(0, (this.playhead - now - target) * 1000);
    const emergencyBacklog = AUDIO_SYNC_V2 && backlogMs / 1000 > EMERGENCY_BACKLOG_S;
    const normalBacklog = AUDIO_SYNC_V2 && backlogMs / 1000 > NORMAL_BACKLOG_S;
    if (emergencyBacklog) {
      audioSyncDebug('emergency audio backlog', {
        streamId: timing.streamId,
        audioSeq: timing.audioSeq,
        backlogMs: Math.round(backlogMs),
      });
    } else if (normalBacklog) {
      audioSyncDebug('audio backlog', {
        streamId: timing.streamId,
        audioSeq: timing.audioSeq,
        backlogMs: Math.round(backlogMs),
      });
    } else if (AUDIO_SYNC_V2 && underrun) {
      audioSyncDebug('audio underrun', {
        streamId: timing.streamId,
        audioSeq: timing.audioSeq,
      });
    }

    return {
      accepted: true,
      streamId: timing.streamId,
      audioSeq: timing.audioSeq,
      audioStartMs: timing.audioStartMs,
      durationMs: scheduled.durationMs,
      localStartTimeMs: Math.round(localStartTime * 1000),
      localEndTimeMs: Math.round(localEndTime * 1000),
      backlogMs: Math.round(backlogMs),
      dropped,
      emergencyBacklog,
      underrun,
    };
  }

  getAudibleAudioOffsetMs(streamId?: string): number | null {
    if (!this.ctx) return null;
    const now = this.ctx.currentTime;
    const chunks = this.scheduled
      .filter((chunk) => chunk.audioStartMs !== undefined && (!streamId || chunk.streamId === streamId))
      .sort((a, b) => a.localStartTime - b.localStartTime);
    if (!chunks.length) return null;

    for (const chunk of chunks) {
      if (now >= chunk.localStartTime && now <= chunk.localEndTime) {
        return chunk.audioStartMs! + (now - chunk.localStartTime) * 1000;
      }
    }

    const first = chunks[0];
    if (now < first.localStartTime) return first.audioStartMs ?? null;

    const last = chunks[chunks.length - 1];
    if (last.audioStartMs === undefined || last.durationMs === undefined) return null;
    return last.audioStartMs + last.durationMs;
  }

  hasTimeline(streamId?: string): boolean {
    return this.scheduled.some(
      (chunk) => chunk.audioStartMs !== undefined && (!streamId || chunk.streamId === streamId)
    );
  }

  setVolume(v: number): void {
    this._volume = Math.max(0, Math.min(1, v));
    this.applyGain();
  }

  setMuted(m: boolean): void {
    this._muted = m;
    this.applyGain();
  }

  get muted(): boolean {
    return this._muted;
  }

  private applyGain(): void {
    if (this.gain) this.gain.gain.value = this._muted ? 0 : this._volume;
  }

  close(): void {
    for (const chunk of this.scheduled) {
      try {
        chunk.src.stop();
      } catch {
        /* already stopped */
      }
    }
    this.scheduled = [];
    if (this.el) {
      this.el.pause();
      this.el.srcObject = null;
      this.el.remove();
      this.el = null;
    }
    void this.ctx?.close();
    this.ctx = null;
    this.gain = null;
    this.playhead = 0;
  }
}
