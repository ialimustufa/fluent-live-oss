import { useEffect, useRef, type ReactNode } from 'react';

export interface TranscriptLine {
  text: string;
  isFinal: boolean;
}

interface Props {
  lines: TranscriptLine[]; // recent finals plus at most one trailing partial
  label: string;
  position: 'top' | 'bottom';
  accent?: boolean; // Spectrum label styling for the translated/target bar
  size?: 'fill' | 'lg' | 'md' | 'sm';
  action?: ReactNode;
}

const SIZES = {
  // `fill` grows to occupy its flex parent (used for the primary translation
  // bar on mobile, where the slide is a compact 16:9 strip).
  fill: { pad: 'py-3', scroll: 'h-full', text: 'text-2xl leading-9' },
  lg: { pad: 'py-4', scroll: 'h-28', text: 'text-3xl leading-10' },
  md: { pad: 'py-3', scroll: 'h-16', text: 'text-xl leading-8' },
  sm: { pad: 'py-2', scroll: 'h-11', text: 'text-base leading-6' }, // ≥16px so source captions stay legible
};

/**
 * Rolling transcript bar: shows the latest lines and auto-scrolls to follow
 * live speech — but the region is scrollable, so viewers can scroll up to read
 * back. The translated (top) bar is rendered large for visibility; the English
 * (bottom) bar is small and de-emphasized.
 */
export default function TranscriptBar({ lines, label, position, accent, size = 'md', action }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const s = SIZES[size];

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  };

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [lines]);

  // Finalized text is always full contrast; live partials stay readable (muted,
  // not faint+italic). De-emphasis of the source bar comes from size, not wash-out.
  const finalColor = 'text-[var(--fg)]';
  const partialColor = 'text-[var(--muted)]';

  return (
    <div
      className={`glass-panel flex items-stretch gap-3 px-5 ${s.pad} ${
        size === 'fill' ? 'min-h-0 flex-1' : ''
      } ${position === 'top' ? 'border-b' : 'border-t'} border-[var(--border)]`}
    >
      <span
        className={`self-center whitespace-nowrap rounded-full px-3 py-1 text-[11px] font-bold uppercase tracking-[.13em] ${
          accent
            ? 'grad-fill'
            : 'bg-[var(--surface-2)] text-[var(--faint)] ring-1 ring-inset ring-[var(--border)]'
        }`}
      >
        {label}
      </span>
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className={`font-display flex-1 overflow-y-auto overscroll-contain text-pretty font-semibold ${s.scroll} ${s.text}`}
        aria-live="polite"
      >
        {lines.length === 0 ? (
          <span className="text-[var(--faint)]">…</span>
        ) : (
          lines.map((l, i) => (
            <span key={i} className={l.isFinal ? finalColor : partialColor}>
              {l.text}{' '}
            </span>
          ))
        )}
      </div>
      {action && <div className="flex shrink-0 items-center self-center">{action}</div>}
    </div>
  );
}
