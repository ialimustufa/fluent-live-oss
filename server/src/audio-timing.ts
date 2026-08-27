export const TRANSLATED_AUDIO_SAMPLE_RATE = 24_000;
export const PCM16_BYTES_PER_SAMPLE = 2;

export function pcm16Base64DurationMs(
  base64Pcm16: string,
  sampleRate = TRANSLATED_AUDIO_SAMPLE_RATE
): number {
  if (!base64Pcm16 || sampleRate <= 0) return 0;
  const bytes = Buffer.from(base64Pcm16, 'base64').length;
  const samples = Math.floor(bytes / PCM16_BYTES_PER_SAMPLE);
  return Math.round((samples / sampleRate) * 1000);
}
