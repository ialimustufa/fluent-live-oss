import { useCallback, useState } from 'react';
import type { TranscriptLine } from '../components/TranscriptBar';

// Keep a deep tail so viewers can scroll back through the running transcript;
// the bar still shows only the latest lines until you scroll up.
const MAX_FINAL_LINES = 80;

interface TranscriptState {
  finals: string[];
  partial: string | null;
}

/**
 * Rolling transcript state for one bar: recent final lines plus at most one
 * trailing partial (partials replace each other; finals append and roll).
 */
export function useTranscriptLines(): {
  lines: TranscriptLine[];
  push: (text: string, isFinal: boolean) => void;
  seed: (finals: string[]) => void;
} {
  const [state, setState] = useState<TranscriptState>({ finals: [], partial: null });

  const push = useCallback((text: string, isFinal: boolean) => {
    setState((s) =>
      isFinal
        ? { finals: [...s.finals, text].slice(-MAX_FINAL_LINES), partial: null }
        : { ...s, partial: text }
    );
  }, []);

  const seed = useCallback((finals: string[]) => {
    setState({ finals: finals.slice(-MAX_FINAL_LINES), partial: null });
  }, []);

  const lines: TranscriptLine[] = state.finals.map((text) => ({ text, isFinal: true }));
  if (state.partial) lines.push({ text: state.partial, isFinal: false });

  return { lines, push, seed };
}
