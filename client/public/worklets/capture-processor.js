/**
 * AudioWorklet processor: downsamples mic input from the context sample rate
 * to 16 kHz mono Int16 PCM and posts ~100 ms frames (1600 samples) to the
 * main thread. Runs off the main thread so UI jank can't drop audio.
 */
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.targetRate = 16000;
    this.frameSamples = 1600; // 100 ms @ 16 kHz
    this.out = new Int16Array(this.frameSamples);
    this.outIndex = 0;
    this.readPos = 0; // fractional read position into the input stream
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel || channel.length === 0) return true;

    const ratio = sampleRate / this.targetRate;
    // Linear-interpolation downsample of this render quantum.
    while (this.readPos < channel.length - 1) {
      const i = Math.floor(this.readPos);
      const frac = this.readPos - i;
      const sample = channel[i] * (1 - frac) + channel[i + 1] * frac;
      const clamped = Math.max(-1, Math.min(1, sample));
      this.out[this.outIndex++] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
      if (this.outIndex === this.frameSamples) {
        this.port.postMessage(this.out.buffer.slice(0));
        this.outIndex = 0;
      }
      this.readPos += ratio;
    }
    this.readPos -= channel.length;
    if (this.readPos < 0) this.readPos = 0;
    return true;
  }
}

registerProcessor('capture-processor', CaptureProcessor);
