import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { fetchTranscript, fetchPolls, type TranscriptData, type TranscriptSegment, type PollResult } from '../lib/api';
import PollResults from '../components/PollResults';

function fmtOffset(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * Pair input/output segments into time-aligned rows, grouped by slide.
 * Segments are merged in t_offset order; a row holds the nearest
 * source/translation pair.
 */
function buildRows(segments: TranscriptSegment[]) {
  const bySlide = new Map<number, TranscriptSegment[]>();
  for (const seg of segments) {
    const list = bySlide.get(seg.slideIndex) ?? [];
    list.push(seg);
    bySlide.set(seg.slideIndex, list);
  }
  return [...bySlide.entries()].sort((a, b) => a[0] - b[0]);
}

export default function TranscriptPage() {
  const { slug = '' } = useParams();
  const [data, setData] = useState<TranscriptData | null>(null);
  const [polls, setPolls] = useState<PollResult[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchTranscript(slug).then(setData).catch((e) => setError(String(e.message ?? e)));
    fetchPolls(slug).then(setPolls).catch(() => {});
  }, [slug]);

  if (error) {
    return <div className="bg-aurora flex min-h-screen items-center justify-center text-[var(--muted)]">{error}</div>;
  }
  if (!data) {
    return <div className="bg-aurora flex min-h-screen items-center justify-center text-[var(--faint)]">Loading…</div>;
  }

  const groups = buildRows(data.segments);

  return (
    <div className="bg-aurora min-h-screen px-4 py-12">
      <div className="animate-fade-up mx-auto max-w-3xl">
        <Link to={`/${slug}`} className="text-sm text-[var(--faint)] transition hover:text-[var(--fg)]">
          ← Back to talk
        </Link>
        <h1 className="mt-4 text-3xl font-bold text-[var(--fg)]">
          {data.title || 'Talk transcript'}
        </h1>
        <div className="mb-10 mt-3 flex flex-wrap items-center gap-2 text-xs">
          <span className="grad-text px-0.5 py-1 font-bold">
            EN → {data.targetLang}
          </span>
          {data.startedAt && (
            <span className="rounded-full bg-[var(--surface-2)] px-2.5 py-1 text-[var(--muted)] ring-1 ring-inset ring-[var(--border)]">
              {new Date(data.startedAt + 'Z').toLocaleString()}
            </span>
          )}
          {data.state !== 'ended' && (
            <span className="flex items-center gap-1.5 rounded-full bg-[var(--surface-2)] px-2.5 py-1 text-[var(--muted)] ring-1 ring-inset ring-[var(--border)]">
              <span className="live-dot" /> in progress
            </span>
          )}
        </div>

        {groups.length === 0 && <p className="text-[var(--faint)]">No transcript was recorded.</p>}

        {groups.map(([slideIndex, segs]) => (
          <section key={slideIndex} className="mb-10">
            <h2 className="grad-text mb-4 text-xs font-bold uppercase tracking-widest">
              Slide {slideIndex + 1}
            </h2>
            <div className="space-y-4 border-l border-[var(--border)] pl-5">
              {segs.map((seg, i) => (
                <div key={i} className="flex gap-4">
                  <span className="w-11 shrink-0 pt-1 font-mono text-xs text-[var(--faint)]">
                    {fmtOffset(seg.tOffsetMs)}
                  </span>
                  <p className={`flex-1 leading-relaxed ${seg.kind === 'input' ? 'text-[var(--faint)]' : 'text-[var(--fg)]'}`}>
                    <span
                      className={`mr-2 rounded px-1.5 py-0.5 align-middle text-[10px] font-semibold uppercase ring-1 ring-inset ${
                        seg.kind === 'output'
                          ? 'grad-text ring-transparent'
                          : 'bg-[var(--surface-2)] text-[var(--faint)] ring-[var(--border)]'
                      }`}
                    >
                      {seg.languageCode}
                    </span>
                    {seg.text}
                  </p>
                </div>
              ))}
            </div>
          </section>
        ))}

        {polls.length > 0 && (
          <section className="mb-10">
            <h2 className="grad-text mb-4 text-xs font-bold uppercase tracking-widest">Poll results</h2>
            <div className="space-y-5">
              {polls.map((p) => (
                <div key={p.pollId} className="rounded-2xl bg-[var(--surface-2)] p-4 ring-1 ring-inset ring-[var(--border)]">
                  <PollResults
                    poll={{
                      id: p.pollId,
                      question: p.question,
                      options: p.options,
                      counts: p.counts,
                      total: p.total,
                      closed: true,
                      pinned: true,
                      correctOptions: p.correctOptions,
                    }}
                  />
                </div>
              ))}
            </div>
          </section>
        )}

      </div>
    </div>
  );
}
