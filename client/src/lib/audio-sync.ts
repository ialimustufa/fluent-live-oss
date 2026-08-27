import { useCallback, useEffect, useRef } from 'react';
import { useTranscriptLines } from './useTranscripts';

export const AUDIO_SYNC_V2 =
  import.meta.env.VITE_AUDIO_SYNC_V2 !== 'false' && import.meta.env.VITE_AUDIO_SYNC_V2 !== '0';

export interface AudioTimingMetadata {
  streamId?: string;
  audioSeq?: number;
  audioStartMs?: number;
  durationMs?: number;
  serverSentAtMs?: number;
}

export interface CaptionTimingMetadata {
  streamId?: string;
  captionSeq?: number;
  captionAudioOffsetMs?: number;
  serverSentAtMs?: number;
}

export interface AudioMarkerPayload extends Required<AudioTimingMetadata> {
  track: 'translated' | 'source';
  publisherGeneration?: number;
  sfuSentAtMs?: number;
  sfuQueueMs?: number;
}

interface PendingCaption {
  text: string;
  isFinal: boolean;
  streamId: string;
  seq: number;
  audioOffsetMs: number;
  receivedAtMs: number;
}

export interface CaptionSyncDiagnostic {
  event: 'display' | 'fallback' | 'drop-stale';
  streamId: string;
  seq: number;
  lagMs?: number;
  pending?: number;
}

export function audioSyncDebug(message: string, data?: unknown): void {
  if (!AUDIO_SYNC_V2 || !import.meta.env.DEV) return;
  if (data) console.debug(`[audio-sync] ${message}`, data);
  else console.debug(`[audio-sync] ${message}`);
}

export function useSyncedTranscriptLines(opts: {
  enabled: boolean;
  fallbackMs?: number | null;
  getAudioOffsetMs: (streamId?: string) => number | null;
  isSyncAvailable: (streamId?: string) => boolean;
  onDiagnostic?: (diagnostic: CaptionSyncDiagnostic) => void;
}) {
  const transcript = useTranscriptLines();
  const pendingRef = useRef<PendingCaption[]>([]);
  const activeStreamRef = useRef<string | null>(null);
  const fallbackMs = opts.fallbackMs ?? 750;
  const fallbackEnabled = typeof fallbackMs === 'number' && Number.isFinite(fallbackMs);

  const flushDue = useCallback(() => {
    const pending = pendingRef.current;
    if (!pending.length) return;

    const now = performance.now();
    const ready: PendingCaption[] = [];
    const kept: PendingCaption[] = [];

    for (const item of pending) {
      const audioOffset = opts.getAudioOffsetMs(item.streamId);
      const syncAvailable = opts.isSyncAvailable(item.streamId);
      const dueByAudio = audioOffset !== null && audioOffset + 60 >= item.audioOffsetMs;
      const dueByFallback =
        fallbackEnabled && (!syncAvailable || audioOffset === null) && now - item.receivedAtMs >= fallbackMs;

      if (dueByAudio || dueByFallback) ready.push(item);
      else kept.push(item);

      if (!dueByAudio && !dueByFallback) {
        kept.push(...pending.slice(ready.length + kept.length));
        break;
      }
    }

    if (!ready.length) return;
    pendingRef.current = kept;
    for (const item of ready) {
      transcript.push(item.text, item.isFinal);
      const audioOffset = opts.getAudioOffsetMs(item.streamId);
      const lagMs = audioOffset === null ? undefined : Math.round(audioOffset - item.audioOffsetMs);
      opts.onDiagnostic?.({
        event: audioOffset === null ? 'fallback' : 'display',
        streamId: item.streamId,
        seq: item.seq,
        lagMs,
        pending: pendingRef.current.length,
      });
      audioSyncDebug(audioOffset === null ? 'caption fallback' : 'caption display', {
        streamId: item.streamId,
        seq: item.seq,
        lagMs,
        pending: pendingRef.current.length,
      });
    }
  }, [fallbackMs, opts, transcript]);

  useEffect(() => {
    if (!opts.enabled) return;
    const id = window.setInterval(flushDue, 50);
    return () => clearInterval(id);
  }, [flushDue, opts.enabled]);

  const push = useCallback(
    (text: string, isFinal: boolean, metadata?: CaptionTimingMetadata) => {
      if (
        !opts.enabled ||
        !metadata?.streamId ||
        metadata.captionSeq === undefined ||
        metadata.captionAudioOffsetMs === undefined
      ) {
        transcript.push(text, isFinal);
        return;
      }

      if (activeStreamRef.current && activeStreamRef.current !== metadata.streamId) {
        for (const item of pendingRef.current) {
          opts.onDiagnostic?.({ event: 'drop-stale', streamId: item.streamId, seq: item.seq });
        }
        pendingRef.current = [];
      }
      activeStreamRef.current = metadata.streamId;

      pendingRef.current.push({
        text,
        isFinal,
        streamId: metadata.streamId,
        seq: metadata.captionSeq,
        audioOffsetMs: metadata.captionAudioOffsetMs,
        receivedAtMs: performance.now(),
      });
      pendingRef.current.sort((a, b) => a.seq - b.seq);
      flushDue();
    },
    [flushDue, opts, transcript]
  );

  const seed = useCallback(
    (finals: string[]) => {
      pendingRef.current = [];
      activeStreamRef.current = null;
      transcript.seed(finals);
    },
    [transcript]
  );

  return { lines: transcript.lines, push, seed };
}
