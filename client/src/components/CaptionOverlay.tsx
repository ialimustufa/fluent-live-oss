import { useEffect, useRef } from 'react';
import type { TranscriptLine } from './TranscriptBar';

interface Props {
  lines: TranscriptLine[];
  label?: string;
  /** Extra classes on the root (e.g. height/background for PiP vs overlay). */
  className?: string;
}

/**
 * Large live translated captions on a translucent backdrop. Bottom-aligned,
 * auto-scrolls to the latest line. Shared by the /present stage overlay and the
 * Document Picture-in-Picture caption window.
 */
export default function CaptionOverlay({ lines, label, className = '' }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [lines]);

  return (
    <div className={`relative flex flex-col justify-end gap-2 overflow-hidden ${className}`}>
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-full bg-scrim" />
      {label && (
        <span className="grad-text relative w-fit text-xs font-bold uppercase tracking-widest">
          {label} · LIVE
        </span>
      )}
      <div
        ref={ref}
        className="font-display relative overflow-y-auto text-pretty text-3xl font-semibold leading-snug text-[var(--fg)] sm:text-4xl"
        aria-live="polite"
      >
        {lines.length === 0 ? (
          <span className="text-[var(--faint)]">…</span>
        ) : (
          lines.map((l, i) => (
            <span key={i} className={l.isFinal ? 'text-[var(--fg)]' : 'text-[var(--muted)]'}>
              {l.text}{' '}
            </span>
          ))
        )}
      </div>
    </div>
  );
}
