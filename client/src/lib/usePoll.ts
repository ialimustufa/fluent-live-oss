import { useCallback, useEffect, useRef, useState } from 'react';
import type { LivePoll } from './api';

/**
 * Live poll state for a session. The server broadcasts the full `LivePoll`
 * (or null) on `poll.state` and in the join snapshot; this hook holds the
 * latest and tracks which option this viewer chose (reset when the poll changes).
 *
 * `autoHideClosedMs` (>0 on viewer/present): once a poll is closed AND not
 * pinned by the host, hide it locally after that delay. The host passes 0 so it
 * keeps managing the poll.
 */
export function usePoll(autoHideClosedMs = 0) {
  const [poll, setPoll] = useState<LivePoll | null>(null);
  const [myVote, setMyVote] = useState<number | null>(null);
  const lastId = useRef<string | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const apply = useCallback((next: LivePoll | null) => {
    if ((next?.id ?? null) !== lastId.current) {
      lastId.current = next?.id ?? null;
      setMyVote(null);
    }
    setPoll(next);
  }, []);

  // Auto-hide a closed, unpinned poll after the delay (viewer/present only).
  useEffect(() => {
    if (hideTimer.current) {
      clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
    if (autoHideClosedMs > 0 && poll && poll.closed && !poll.pinned) {
      hideTimer.current = setTimeout(() => setPoll(null), autoHideClosedMs);
    }
    return () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
  }, [poll, autoHideClosedMs]);

  return { poll, myVote, setMyVote, apply };
}
