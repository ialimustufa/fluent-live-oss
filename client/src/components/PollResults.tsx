import { Check } from 'lucide-react';
import type { LivePoll } from '../lib/api';

/**
 * Live poll result bars. `myVote` highlights this viewer's choice. When the
 * poll is a closed quiz (`correctOptions` present), correct options are marked
 * with text + icon and the viewer's choice is marked right/wrong.
 */
export default function PollResults({
  poll,
  myVote,
}: {
  poll: LivePoll;
  myVote?: number | null;
}) {
  const correct = poll.correctOptions ?? [];
  const isQuiz = correct.length > 0;
  const maxCount = Math.max(0, ...poll.counts);

  return (
    <div className="space-y-2">
      <p className="font-semibold text-[var(--fg)]">{poll.question}</p>
      <div className="space-y-1.5">
        {poll.options.map((opt, i) => {
          const c = poll.counts[i] ?? 0;
          const pct = poll.total ? Math.round((c / poll.total) * 100) : 0;
          const mine = myVote === i;
          const isCorrect = correct.includes(i);
          const isWinner = poll.total > 0 && c > 0 && c === maxCount;
          return (
            <div
              key={i}
              className={`relative overflow-hidden rounded-[var(--r-md)] ring-1 ring-inset ${
                isCorrect ? 'ring-[var(--accent-ring)]' : mine ? 'ring-[var(--accent-ring)]' : 'ring-[var(--border)]'
              }`}
            >
              <div
                className={`absolute inset-y-0 left-0 transition-[width] duration-500 ${
                  isCorrect || isWinner ? 'grad-fill opacity-90' : 'bg-[var(--surface-3)]'
                }`}
                style={{ width: `${pct}%` }}
              />
              <div className="relative flex items-center justify-between gap-2 px-3 py-2 text-sm">
                <span className="flex min-w-0 items-center gap-1.5 text-[var(--fg)]">
                  {/* Correct is marked with an icon + label, never colour alone. */}
                  {isCorrect && (
                    <span className="grad-fill inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide">
                      <Check size={11} /> Correct
                    </span>
                  )}
                  <span className="truncate">{opt}</span>
                  {mine && <span className="shrink-0 text-[11px] text-[var(--faint)]">· your pick</span>}
                </span>
                <span className="shrink-0 font-mono text-xs text-[var(--muted)]">
                  {pct}% · {c}
                </span>
              </div>
            </div>
          );
        })}
      </div>
      <p className="text-xs text-[var(--faint)]">
        {poll.total} vote{poll.total === 1 ? '' : 's'}
        {poll.closed && ' · closed'}
        {isQuiz && myVote != null && (correct.includes(myVote) ? ' · you were right' : ' · not quite')}
      </p>
    </div>
  );
}
