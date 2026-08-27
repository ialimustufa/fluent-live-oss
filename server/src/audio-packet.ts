const PACKET_PAYLOAD_FIELD_TAG = 42; // field 5, wire type 2
// The SFU payload is 48 kHz stereo 16-bit PCM: 48000 * 2ch * 2bytes = 192 bytes/ms.
const SFU_BYTES_PER_MS = 192;
const SFU_FRAME_MS = 20;
const SFU_FRAME_PAYLOAD_BYTES = SFU_BYTES_PER_MS * SFU_FRAME_MS;

/** One SFU-framed packet plus how much real-time audio it represents. */
export interface SfuFrame {
  packet: Buffer;
  durationMs: number;
}

function writeVarint(value: number): number[] {
  const out: number[] = [];
  let n = value >>> 0;
  while (n >= 0x80) {
    out.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  out.push(n);
  return out;
}

function readVarint(buf: Buffer, offset: number): { value: number; offset: number } | null {
  let value = 0;
  let shift = 0;
  let pos = offset;
  while (pos < buf.length && shift <= 28) {
    const byte = buf[pos++];
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value: value >>> 0, offset: pos };
    shift += 7;
  }
  return null;
}

export function encodeSfuPacket(payload: Buffer): Buffer {
  const header = Buffer.from([PACKET_PAYLOAD_FIELD_TAG, ...writeVarint(payload.length)]);
  return Buffer.concat([header, payload]);
}

export function decodeSfuPacket(data: Buffer): Buffer | null {
  let offset = 0;
  while (offset < data.length) {
    const tag = readVarint(data, offset);
    if (!tag) return null;
    offset = tag.offset;
    const fieldNo = tag.value >>> 3;
    const wireType = tag.value & 0x7;

    if (wireType === 0) {
      const skipped = readVarint(data, offset);
      if (!skipped) return null;
      offset = skipped.offset;
      continue;
    }

    if (wireType !== 2) return null;
    const len = readVarint(data, offset);
    if (!len || len.offset + len.value > data.length) return null;
    offset = len.offset;
    const payload = data.subarray(offset, offset + len.value);
    offset += len.value;
    if (fieldNo === 5) return Buffer.from(payload);
  }
  return null;
}

function readInt16LE(buf: Buffer, sampleIndex: number): number {
  return buf.readInt16LE(sampleIndex * 2);
}

function writeInt16LE(buf: Buffer, sampleIndex: number, value: number): void {
  buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(value))), sampleIndex * 2);
}

function evenPcm(buf: Buffer): Buffer {
  return buf.length % 2 === 0 ? buf : buf.subarray(0, buf.length - 1);
}

export function pcm24kMonoBase64ToSfuPackets(base64Pcm24kMono: string): Buffer[] {
  return pcm24kMonoBase64ToSfuFrames(base64Pcm24kMono).map((f) => f.packet);
}

/**
 * Like {@link pcm24kMonoBase64ToSfuPackets} but each packet is tagged with the
 * real-time duration of audio it carries, so the publisher can pace delivery to
 * the SFU at 1× (a live-mic feed) instead of bursting.
 */
export function pcm24kMonoBase64ToSfuFrames(base64Pcm24kMono: string): SfuFrame[] {
  const mono24 = evenPcm(Buffer.from(base64Pcm24kMono, 'base64'));
  const samples = Math.floor(mono24.length / 2);
  if (samples === 0) return [];

  // 24 kHz mono -> 48 kHz mono by linear interpolation, then duplicate L/R.
  const stereo48 = Buffer.alloc(samples * 2 * 2 * 2);
  for (let i = 0; i < samples; i++) {
    const current = readInt16LE(mono24, i);
    const next = i + 1 < samples ? readInt16LE(mono24, i + 1) : current;
    const interpolated = (current + next) / 2;
    const frame = i * 2;
    writeInt16LE(stereo48, frame * 2, current);
    writeInt16LE(stereo48, frame * 2 + 1, current);
    writeInt16LE(stereo48, (frame + 1) * 2, interpolated);
    writeInt16LE(stereo48, (frame + 1) * 2 + 1, interpolated);
  }

  const frames: SfuFrame[] = [];
  for (let offset = 0; offset < stereo48.length; offset += SFU_FRAME_PAYLOAD_BYTES) {
    let end = Math.min(offset + SFU_FRAME_PAYLOAD_BYTES, stereo48.length);
    // Preserve whole stereo frames: 4 bytes per 48 kHz stereo frame.
    end -= (end - offset) % 4;
    if (end <= offset) break;
    const payload = stereo48.subarray(offset, end);
    frames.push({ packet: encodeSfuPacket(payload), durationMs: payload.length / SFU_BYTES_PER_MS });
  }
  return frames;
}
