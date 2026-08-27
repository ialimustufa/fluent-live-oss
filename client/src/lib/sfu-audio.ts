import { subscribeAudio } from './api';
import { audioSyncDebug, type AudioMarkerPayload } from './audio-sync';

type SinkEl = HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
// Receive jitter-buffer target. We deliberately run this LARGE: a deeper buffer
// rides out late/bursty packets so WebRTC drops far less audio mid-message
// (completeness > latency, per product requirement — lag is acceptable, cutting
// the message is not). It can't fully guarantee zero drops the way a never-drop
// WS buffer would, but it cuts much less. Tune down toward ~300 for lower
// latency if cutting is acceptable. Chrome clamps this to [0, 4000] ms.
const JITTER_TARGET_MS = 1000;
const WEBRTC_DISCONNECTED_MS = 8_000;
const MARKER_STALL_GRACE_MS = 4_000;
const PUBLISHER_RECOVERY_COOLDOWN_MS = 12_000;
const HEADER_ONLY_BYTES_PER_PACKET = 16;

type MarkerState = AudioMarkerPayload & {
  receivedAtMs: number;
  bytesAtReceive: number;
  packetsAtReceive: number;
  energyAtReceive: number;
};

export class RealtimeAudioSubscriber {
  private pc: RTCPeerConnection | null = null;
  private el: SinkEl | null = null;
  private stream: MediaStream | null = null;
  private _volume = 1;
  private _muted = false;
  private lastMarker: MarkerState | null = null;
  private estimatedPlayoutDelayMs = 650;
  private statsTimer: number | null = null;
  private disconnectTimer: number | null = null;
  private slug: string | null = null;
  private reconnecting = false;
  private publisherGeneration: number | null = null;
  private lastPacketsReceived = 0;
  private lastBytesReceived = 0;
  private lastAudioEnergy = 0;
  private lastDecodedAudioAtMs = 0;
  private headerOnlySinceMs: number | null = null;
  private lastPublisherRecoveryAtMs = 0;

  async connect(
    slug: string,
    opts: { recoverPublisher?: boolean; reason?: string } = {}
  ): Promise<void> {
    this.closeConnectionOnly();
    this.slug = slug;

    const pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }],
    });
    const el = new Audio() as SinkEl;
    // NOTE: no `autoplay` and no duplicate play() calls. Multiple play() calls
    // (autoplay + explicit) racing a srcObject change produce AbortError and the
    // element never actually starts. We assign srcObject once and play once.
    el.setAttribute('playsinline', '');
    el.setAttribute('webkit-playsinline', '');
    el.style.display = 'none';
    document.body.appendChild(el);

    this.pc = pc;
    this.el = el;
    this.applyAudioSettings();

    // Always-on diagnostics for the Cloudflare → viewer leg (low volume).
    pc.onconnectionstatechange = () => {
      console.info('[sfu] connectionState', pc.connectionState);
      this.handleConnectionState(pc.connectionState);
    };
    pc.oniceconnectionstatechange = () => {
      console.info('[sfu] iceConnectionState', pc.iceConnectionState);
      this.handleIceConnectionState(pc.iceConnectionState);
    };
    el.onplaying = () => console.info('[sfu] audio element playing');
    el.onpause = () => console.info('[sfu] audio element paused');
    el.oncanplay = () => void this.safePlay();

    pc.addTransceiver('audio', { direction: 'recvonly' });
    pc.ontrack = (ev) => {
      const track = ev.track;
      console.info('[sfu] ontrack', { kind: track.kind, streams: ev.streams.length, muted: track.muted });
      track.onunmute = () => console.info('[sfu] track unmuted (media flowing)');
      track.onmute = () => console.info('[sfu] track muted (media stalled)');
      const remote = ev.streams[0] ?? new MediaStream([track]);
      if (el.srcObject !== remote) {
        this.stream = remote;
        el.srcObject = remote;
      }
      this.requestLowLatency(ev.receiver);
      void this.safePlay();
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const answer = await subscribeAudio(slug, offer, {
      recoverPublisher: opts.recoverPublisher,
      publisherGeneration: this.publisherGeneration ?? undefined,
      reason: opts.reason,
    });
    this.publisherGeneration = answer.publisherGeneration;
    await pc.setRemoteDescription(answer.sessionDescription);
    console.info('[sfu] subscribed; remote description set', {
      publisherGeneration: this.publisherGeneration,
    });
    this.startStatsPolling();
  }

  /** Pin the receive jitter buffer low so audio plays close to live. Uses the
   *  modern jitterBufferTarget (ms) and falls back to playoutDelayHint (s). */
  private requestLowLatency(receiver: RTCRtpReceiver): void {
    const r = receiver as unknown as Record<string, unknown>;
    try {
      if ('jitterBufferTarget' in receiver) {
        r.jitterBufferTarget = JITTER_TARGET_MS;
        console.info('[sfu] jitterBufferTarget set', JITTER_TARGET_MS, 'ms');
      } else if ('playoutDelayHint' in receiver) {
        r.playoutDelayHint = JITTER_TARGET_MS / 1000;
        console.info('[sfu] playoutDelayHint set', JITTER_TARGET_MS / 1000, 's');
      } else {
        console.info('[sfu] no jitter-buffer control on this browser');
      }
    } catch (e) {
      console.warn('[sfu] jitter target unsupported', (e as Error)?.name);
    }
  }

  /** Single, idempotent play() — only when paused, so retries (oncanplay,
   *  ontrack) can't interrupt each other into AbortError. */
  private async safePlay(): Promise<void> {
    const el = this.el;
    if (!el || !el.paused) return;
    try {
      await el.play();
      console.info('[sfu] play() ok');
    } catch (e) {
      console.warn('[sfu] play() rejected', (e as Error)?.name);
    }
  }

  setVolume(v: number): void {
    this._volume = Math.max(0, Math.min(1, v));
    this.applyAudioSettings();
  }

  setMuted(muted: boolean): void {
    this._muted = muted;
    this.applyAudioSettings();
  }

  async setSink(deviceId: string): Promise<boolean> {
    try {
      if (this.el?.setSinkId) {
        await this.el.setSinkId(deviceId);
        return true;
      }
    } catch {
      /* unsupported or unavailable */
    }
    return false;
  }

  noteMarker(marker: AudioMarkerPayload): void {
    if (marker.track !== 'translated') return;
    this.lastMarker = {
      ...marker,
      receivedAtMs: performance.now(),
      bytesAtReceive: this.lastBytesReceived,
      packetsAtReceive: this.lastPacketsReceived,
      energyAtReceive: this.lastAudioEnergy,
    };
    if (
      marker.publisherGeneration !== undefined &&
      this.publisherGeneration !== null &&
      marker.publisherGeneration > this.publisherGeneration
    ) {
      void this.reconnect('publisher generation advanced', { recoverPublisher: false });
    }
  }

  getAudibleAudioOffsetMs(streamId?: string): number | null {
    const marker = this.lastMarker;
    if (!marker || (streamId && marker.streamId !== streamId)) return null;
    const elapsedMs = performance.now() - marker.receivedAtMs - this.estimatedPlayoutDelayMs;
    return marker.audioStartMs + Math.max(0, elapsedMs);
  }

  hasTimingConfidence(streamId?: string): boolean {
    const marker = this.lastMarker;
    if (!this.pc || !marker || (streamId && marker.streamId !== streamId)) return false;
    return performance.now() - marker.receivedAtMs < 10_000;
  }

  close(): void {
    this.slug = null;
    this.publisherGeneration = null;
    this.closeConnectionOnly();
  }

  private closeConnectionOnly(): void {
    if (this.statsTimer !== null) {
      clearInterval(this.statsTimer);
      this.statsTimer = null;
    }
    if (this.disconnectTimer !== null) {
      clearTimeout(this.disconnectTimer);
      this.disconnectTimer = null;
    }
    this.pc?.close();
    this.pc = null;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    if (this.el) {
      this.el.pause();
      this.el.srcObject = null;
      this.el.remove();
      this.el = null;
    }
    this.lastMarker = null;
    this.lastPacketsReceived = 0;
    this.lastBytesReceived = 0;
    this.lastAudioEnergy = 0;
    this.lastDecodedAudioAtMs = 0;
    this.headerOnlySinceMs = null;
  }

  private applyAudioSettings(): void {
    if (!this.el) return;
    this.el.volume = this._volume;
    this.el.muted = this._muted;
  }

  private startStatsPolling(): void {
    if (this.statsTimer !== null) clearInterval(this.statsTimer);
    this.statsTimer = window.setInterval(() => {
      void this.refreshEstimatedPlayoutDelay();
    }, 1_000);
  }

  private async refreshEstimatedPlayoutDelay(): Promise<void> {
    const pc = this.pc;
    if (!pc) return;
    try {
      const stats = await pc.getStats();
      stats.forEach((report) => {
        const inbound = report as RTCInboundRtpStreamStats & {
          jitterBufferDelay?: number;
          jitterBufferEmittedCount?: number;
          bytesReceived?: number;
          packetsReceived?: number;
          packetsLost?: number;
          audioLevel?: number;
          totalAudioEnergy?: number;
        };
        if (inbound.type !== 'inbound-rtp' || inbound.kind !== 'audio') return;

        // Always-on diagnostic. audioLevel/totalAudioEnergy are the decisive
        // signals: >0 means Cloudflare's audio is actually being DECODED (so any
        // silence is an output/element problem); ~0 while bytes climb means the
        // decoded stream is silent (a codec/PCM-format problem upstream).
        const el = this.el;
        const jbMs =
          inbound.jitterBufferDelay && inbound.jitterBufferEmittedCount
            ? Math.round((inbound.jitterBufferDelay / inbound.jitterBufferEmittedCount) * 1000)
            : null;
        console.info('[sfu] inbound-rtp', {
          bytesReceived: inbound.bytesReceived ?? 0,
          packetsReceived: inbound.packetsReceived ?? 0,
          packetsLost: inbound.packetsLost ?? 0,
          audioLevel: inbound.audioLevel ?? 0,
          totalAudioEnergy: inbound.totalAudioEnergy ?? 0,
          jitterBufferMs: jbMs, // actual playout buffer — the dominant SFU latency
          elPaused: el?.paused,
          conn: pc.connectionState,
        });

        this.recordAudioHealth(inbound);

        if (!inbound.jitterBufferDelay || !inbound.jitterBufferEmittedCount) return;
        const jitterMs = (inbound.jitterBufferDelay / inbound.jitterBufferEmittedCount) * 1000;
        if (Number.isFinite(jitterMs) && jitterMs >= 0) {
          this.estimatedPlayoutDelayMs = Math.max(350, Math.min(1500, jitterMs + 350));
          audioSyncDebug('sfu playout estimate', {
            estimatedPlayoutDelayMs: Math.round(this.estimatedPlayoutDelayMs),
          });
        }
      });
    } catch {
      /* stats are best-effort only */
    }
  }

  private recordAudioHealth(inbound: RTCInboundRtpStreamStats & {
    bytesReceived?: number;
    packetsReceived?: number;
    audioLevel?: number;
    totalAudioEnergy?: number;
  }): void {
    const bytes = inbound.bytesReceived ?? 0;
    const packets = inbound.packetsReceived ?? 0;
    const audioLevel = inbound.audioLevel ?? 0;
    const energy = inbound.totalAudioEnergy ?? 0;
    const packetDelta = Math.max(0, packets - this.lastPacketsReceived);
    const byteDelta = Math.max(0, bytes - this.lastBytesReceived);
    const energyAdvanced = energy > this.lastAudioEnergy + 1e-7 || audioLevel > 0.001;
    const now = performance.now();

    if (energyAdvanced) {
      this.lastDecodedAudioAtMs = now;
      this.headerOnlySinceMs = null;
    } else if (packetDelta > 0 && byteDelta <= packetDelta * HEADER_ONLY_BYTES_PER_PACKET) {
      this.headerOnlySinceMs ??= now;
      if (now - this.headerOnlySinceMs > MARKER_STALL_GRACE_MS) {
        audioSyncDebug('sfu header-only packets without decoded energy', {
          publisherGeneration: this.publisherGeneration,
          packetDelta,
          byteDelta,
          bytesReceived: bytes,
          packetsReceived: packets,
        });
      }
    } else if (byteDelta > packetDelta * HEADER_ONLY_BYTES_PER_PACKET) {
      this.headerOnlySinceMs = null;
    }

    this.maybeRecoverPublisherFromMarker(now, bytes, packets, energy);
    this.lastBytesReceived = bytes;
    this.lastPacketsReceived = packets;
    this.lastAudioEnergy = Math.max(this.lastAudioEnergy, energy);
  }

  private maybeRecoverPublisherFromMarker(now: number, bytes: number, packets: number, energy: number): void {
    const marker = this.lastMarker;
    if (!marker) return;
    if (
      marker.publisherGeneration !== undefined &&
      this.publisherGeneration !== null &&
      marker.publisherGeneration !== this.publisherGeneration
    ) {
      return;
    }

    const expectedAudibleAtMs =
      marker.receivedAtMs + this.estimatedPlayoutDelayMs + MARKER_STALL_GRACE_MS;
    if (now < expectedAudibleAtMs) return;
    if (this.lastDecodedAudioAtMs >= marker.receivedAtMs) return;
    if (now - this.lastPublisherRecoveryAtMs < PUBLISHER_RECOVERY_COOLDOWN_MS) return;

    const packetDelta = Math.max(0, packets - marker.packetsAtReceive);
    const byteDelta = Math.max(0, bytes - marker.bytesAtReceive);
    const energyAdvancedSinceMarker = energy > marker.energyAtReceive + 1e-7;
    const headerOnly = packetDelta > 25 && byteDelta <= packetDelta * HEADER_ONLY_BYTES_PER_PACKET;
    if (!headerOnly || energyAdvancedSinceMarker) return;

    this.lastPublisherRecoveryAtMs = now;
    void this.reconnect('SFU marker did not produce decoded audio', { recoverPublisher: true });
  }

  private handleConnectionState(state: RTCPeerConnectionState): void {
    if (state === 'connected') {
      if (this.disconnectTimer !== null) {
        clearTimeout(this.disconnectTimer);
        this.disconnectTimer = null;
      }
      return;
    }
    if (state === 'failed') {
      void this.reconnect('WebRTC connection failed', { recoverPublisher: false });
      return;
    }
    if (state !== 'disconnected') return;
    if (this.disconnectTimer !== null) return;
    this.disconnectTimer = window.setTimeout(() => {
      this.disconnectTimer = null;
      void this.reconnect('WebRTC disconnected timeout', { recoverPublisher: false });
    }, WEBRTC_DISCONNECTED_MS);
  }

  private handleIceConnectionState(state: RTCIceConnectionState): void {
    if (state === 'failed') {
      void this.reconnect('ICE connection failed', { recoverPublisher: false });
    }
  }

  private async reconnect(
    reason: string,
    opts: { recoverPublisher?: boolean } = {}
  ): Promise<void> {
    const slug = this.slug;
    if (!slug || this.reconnecting) return;
    this.reconnecting = true;
    console.warn('[sfu] reconnecting subscription:', {
      reason,
      recoverPublisher: opts.recoverPublisher === true,
      publisherGeneration: this.publisherGeneration,
    });
    try {
      await this.connect(slug, { recoverPublisher: opts.recoverPublisher, reason });
    } catch (e) {
      console.warn('[sfu] reconnect failed', String((e as Error).message ?? e));
    } finally {
      this.reconnecting = false;
    }
  }
}
