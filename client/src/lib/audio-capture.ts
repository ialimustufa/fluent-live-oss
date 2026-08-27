/**
 * Admin mic capture (spec §4.3): getUserMedia with browser DSP off by default
 * → AudioWorklet downsampler → 100 ms Int16 frames → base64 → caller.
 *
 * DSP is controlled per-processor so Room mode can enable ONLY echo
 * cancellation (the loop-breaker) while leaving noise suppression / AGC off
 * (those are the processors that actually hurt translation quality).
 */
export interface DspConfig {
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
}

export const DSP_OFF: DspConfig = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
};

export interface CaptureOptions {
  deviceId?: string;
  dsp?: DspConfig;
  onChunk: (base64Pcm16k: string) => void;
  onLevel: (rms: number) => void; // 0..1, for the VU meter
  onEnded?: () => void;
}

export class MicCapture {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private worklet: AudioWorkletNode | null = null;
  private analyser: AnalyserNode | null = null;
  private levelTimer: number | null = null;
  private opts: CaptureOptions;
  /** When false (paused), frames are dropped but the graph stays warm. */
  streaming = false;
  /** Half-duplex gate: when true, frames are dropped (translation is playing
   *  on the room speaker — don't feed the echo back to the model). */
  private gated = false;
  /** Manual presenter mute. Capture stays warm, but frames are not sent. */
  private muted = false;
  private readonly handleTrackEnded = () => this.opts.onEnded?.();

  constructor(opts: CaptureOptions) {
    this.opts = opts;
  }

  async start(): Promise<void> {
    await this.acquire(this.opts.deviceId);
  }

  /** Hot-swap mic mid-session by re-acquiring the stream (spec §4.3). */
  async switchDevice(deviceId?: string): Promise<void> {
    this.opts.deviceId = deviceId || undefined;
    await this.acquire(this.opts.deviceId);
  }

  /** Change DSP (e.g. toggling Room mode) — re-acquires the stream so the
   *  new echoCancellation/noiseSuppression constraints take effect. */
  async setDsp(dsp: DspConfig): Promise<void> {
    this.opts.dsp = dsp;
    if (!this.ctx) return; // not started yet; start() will pick it up
    await this.acquire(this.opts.deviceId);
  }

  setGated(gated: boolean): void {
    this.gated = gated;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
  }

  private async acquire(deviceId?: string): Promise<void> {
    const dsp = this.opts.dsp ?? DSP_OFF;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
        echoCancellation: dsp.echoCancellation,
        noiseSuppression: dsp.noiseSuppression,
        autoGainControl: dsp.autoGainControl,
      },
    });

    if (!this.ctx) {
      this.ctx = new AudioContext();
      try {
        await this.ctx.audioWorklet.addModule('/worklets/capture-processor.js');
      } catch (e) {
        stream.getTracks().forEach((t) => t.stop());
        void this.ctx.close();
        this.ctx = null;
        throw e;
      }
    }
    try {
      if (this.ctx.state === 'suspended') await this.ctx.resume();

      const source = this.ctx.createMediaStreamSource(stream);

      const worklet = new AudioWorkletNode(this.ctx, 'capture-processor');
      worklet.port.onmessage = (ev: MessageEvent<ArrayBuffer>) => {
        if (!this.streaming || this.gated || this.muted) return;
        const bytes = new Uint8Array(ev.data);
        let bin = '';
        for (let i = 0; i < bytes.length; i += 0x8000) {
          bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        }
        this.opts.onChunk(btoa(bin));
      };

      const analyser = this.ctx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      source.connect(worklet);
      // Worklet output goes nowhere — we never want mic audio on local speakers.

      const buf = new Float32Array(analyser.fftSize);
      const levelTimer = window.setInterval(() => {
        analyser.getFloatTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
        this.opts.onLevel(Math.min(1, Math.sqrt(sum / buf.length) * 4));
      }, 100);

      stream.getTracks().forEach((track) => {
        track.addEventListener('ended', this.handleTrackEnded);
      });

      this.releaseStream();
      this.stream = stream;
      this.worklet = worklet;
      this.analyser = analyser;
      this.levelTimer = levelTimer;
    } catch (e) {
      stream.getTracks().forEach((t) => t.stop());
      throw e;
    }
  }

  private releaseStream(): void {
    this.stream?.getTracks().forEach((t) => {
      t.removeEventListener('ended', this.handleTrackEnded);
      t.stop();
    });
    this.stream = null;
    this.worklet?.disconnect();
    this.worklet = null;
    this.analyser?.disconnect();
    this.analyser = null;
    if (this.levelTimer !== null) {
      clearInterval(this.levelTimer);
      this.levelTimer = null;
    }
  }

  stop(): void {
    this.streaming = false;
    this.releaseStream();
    void this.ctx?.close();
    this.ctx = null;
  }
}

export interface ListAudioDevicesOptions {
  /** Prompting opens a short-lived mic stream. Avoid it during live recovery. */
  prompt?: boolean;
}

export async function listAudioDevices(): Promise<{
  inputs: MediaDeviceInfo[];
  outputs: MediaDeviceInfo[];
}>;
export async function listAudioDevices(options: ListAudioDevicesOptions): Promise<{
  inputs: MediaDeviceInfo[];
  outputs: MediaDeviceInfo[];
}>;
export async function listAudioDevices(options: ListAudioDevicesOptions = {}): Promise<{
  inputs: MediaDeviceInfo[];
  outputs: MediaDeviceInfo[];
}> {
  const { prompt = true } = options;
  let devices = await navigator.mediaDevices.enumerateDevices();
  const needsPermissionLabels = devices.some((d) => d.kind === 'audioinput' && !d.label);
  if (prompt && needsPermissionLabels) {
    try {
      const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
      probe.getTracks().forEach((t) => t.stop());
      devices = await navigator.mediaDevices.enumerateDevices();
    } catch {
      /* user may have denied; we still enumerate what we can */
    }
  }
  return {
    inputs: devices.filter((d) => d.kind === 'audioinput'),
    outputs: devices.filter((d) => d.kind === 'audiooutput'),
  };
}
