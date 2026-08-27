import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useParams } from 'react-router-dom';
import { MessageSquare, X, BarChart3, ChevronLeft, ChevronRight } from 'lucide-react';
import { fetchSession, type SessionInfo } from '../lib/api';
import { SessionSocket } from '../lib/ws';
import { getAdminKey } from '../lib/adminKey';
import { getTrialHostToken } from '../lib/trial';
import { useTranscriptLines } from '../lib/useTranscripts';
import { useCaptionPip } from '../lib/captionPip';
import { usePoll } from '../lib/usePoll';
import { useReactions } from '../lib/useReactions';
import type { LivePoll } from '../lib/api';
import SlideViewer from '../components/SlideViewer';
import CaptionOverlay from '../components/CaptionOverlay';
import ThemeToggle from '../components/ThemeToggle';
import QrCode from '../components/QrCode';
import ReactionLayer from '../components/ReactionLayer';
import PollResults from '../components/PollResults';

/**
 * Stage / projector view. The presenter projects or screen-shares this: a
 * cohesive header (QR to join · live translated captions · controls) sits above
 * the full-bleed slide. When opened with the operator's token, the presenter can
 * also drive slides here (buttons + ← / → keys) — without taking the audio-host
 * slot, so the Host console's mic stream keeps running.
 */
export default function Present() {
  const { slug = '' } = useParams();
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState('created');
  const [slideIndex, setSlideIndex] = useState(0);
  const [slideCount, setSlideCount] = useState<number | null>(null);
  const output = useTranscriptLines();
  const pip = useCaptionPip();
  const poll = usePoll(10_000); // closed polls auto-hide after 10s unless pinned
  const reactions = useReactions();
  const [dismissedPoll, setDismissedPoll] = useState<string | null>(null);
  const sockRef = useRef<SessionSocket | null>(null);

  const viewerUrl = `${location.origin}/${slug}`;
  // The presenter's token (trial host token, else stored admin key) lets this
  // stage drive slides. Absent it, the page is a read-only display.
  const auth = getTrialHostToken(slug) ?? getAdminKey() ?? '';
  const canPresent = !!auth;

  useEffect(() => {
    fetchSession(slug)
      .then((s) => {
        setSession(s);
        setState(s.state);
        setSlideIndex(s.slideIndex);
      })
      .catch((e) => setError(String(e.message ?? e)));
  }, [slug]);

  useEffect(() => {
    if (!session) return;
    const sock = new SessionSocket(slug, 'viewer', auth || undefined);
    sockRef.current = sock;
    sock.onMessage = (msg) => {
      switch (msg.type) {
        case 'snapshot': {
          const p = msg.payload as {
            state: string;
            slideIndex: number;
            recentTranscripts: { kind: string; text: string }[];
            activePoll: LivePoll | null;
          };
          setState(p.state);
          setSlideIndex(p.slideIndex);
          output.seed(p.recentTranscripts.filter((t) => t.kind === 'output').map((t) => t.text));
          poll.apply(p.activePoll ?? null);
          break;
        }
        case 'poll.state':
          poll.apply(msg.payload as LivePoll | null);
          break;
        case 'reaction':
          reactions.push((msg.payload as { emoji: string }).emoji);
          break;
        case 'transcript.output': {
          const p = msg.payload as { text: string; isFinal: boolean };
          output.push(p.text, p.isFinal);
          break;
        }
        case 'slide.change':
          setSlideIndex((msg.payload as { index: number }).index);
          break;
        case 'session.state':
          setState((msg.payload as { state: string }).state);
          break;
      }
    };
    sock.connect();
    return () => {
      sock.close();
      sockRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, slug]);

  // Drive slides (optimistic local move + broadcast so viewers/host follow).
  const changeSlide = (delta: number) => {
    if (!canPresent) return;
    setSlideIndex((i) => {
      const next = Math.max(0, i + delta);
      const capped = slideCount !== null ? Math.min(next, slideCount - 1) : next;
      if (capped !== i) sockRef.current?.send('slide.change', { index: capped });
      return capped;
    });
  };

  // Keyboard navigation for the presenter (arrows / page keys).
  useEffect(() => {
    if (!canPresent) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight' || e.key === 'PageDown') changeSlide(1);
      else if (e.key === 'ArrowLeft' || e.key === 'PageUp') changeSlide(-1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canPresent, slideCount]);

  if (error) {
    return <div className="bg-aurora flex min-h-screen items-center justify-center text-[var(--muted)]">{error}</div>;
  }
  if (!session) {
    return <div className="bg-aurora flex min-h-screen items-center justify-center text-[var(--faint)]">Loading…</div>;
  }

  const atStart = slideIndex <= 0;
  const atEnd = slideCount !== null && slideIndex >= slideCount - 1;

  return (
    <div className="bg-aurora flex h-[100dvh] flex-col">
      {/* Header: QR · live translated captions · controls — one cohesive bar */}
      <header className="glass relative z-10 flex shrink-0 items-center gap-5 border-b border-[var(--border)] px-6 py-4">
        <div className="grad-rule absolute inset-x-0 bottom-0 h-0.5" />
        {/* QR — for the audience to join on their phones */}
        <div className="flex shrink-0 flex-col items-center gap-1">
          <QrCode url={viewerUrl} size={64} />
          <span className="text-[11px] font-medium text-[var(--muted)]">Scan to join</span>
        </div>

        {/* Translated captions — fill the middle */}
        <div className="min-w-0 flex-1">
          <CaptionOverlay lines={output.lines} label={session.targetLang} className="max-h-28" />
        </div>

        {/* Controls — small icon buttons + title / live status */}
        <div className="flex shrink-0 flex-col items-end gap-2">
          <div className="flex items-center gap-2">
            {pip.supported && (
              <button
                onClick={() => (pip.isOpen ? pip.close() : void pip.open())}
                className={`btn-ghost flex h-9 w-9 items-center justify-center rounded-full text-base ${
                  pip.isOpen ? 'ring-2 ring-[var(--accent-ring)]' : ''
                }`}
                title={pip.isOpen ? 'Close floating caption window' : 'Pop out captions (Chrome/Edge)'}
                aria-label="Toggle floating caption window"
              >
                <MessageSquare size={18} />
              </button>
            )}
            <ThemeToggle />
          </div>
          <div className="max-w-[16rem] truncate text-right text-sm font-semibold text-[var(--fg)]">
            {session.title || 'Fluent'}
          </div>
          <div className="text-[11px] text-[var(--faint)]">
            {state === 'live' ? (
              <span className="grad-text flex items-center gap-1.5">
                <span className="live-dot" /> Live · {session.targetLang}
              </span>
            ) : state === 'paused' ? (
              'Paused'
            ) : state === 'ended' ? (
              'Ended'
            ) : (
              `Waiting · ${session.targetLang}`
            )}
          </div>
        </div>
      </header>

      {/* Slide area (full-bleed below the header) */}
      <div className="relative min-h-0 flex-1">
        <SlideViewer
          slideType={session.slideType}
          slideUrl={session.slideUrl}
          slideIndex={slideIndex}
          onSlideCount={setSlideCount}
        />

        {state === 'created' && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-xl text-[var(--muted)]">
            Waiting for the presenter to start…
          </div>
        )}

        {/* Live poll results, bottom-left over the slide */}
        {poll.poll && poll.poll.id !== dismissedPoll && (
          <div className="glass-panel absolute bottom-6 left-6 w-80 max-w-[40%] animate-fade-up rounded-2xl p-4 shadow-2xl">
            <button
              onClick={() => setDismissedPoll(poll.poll!.id)}
              className="absolute right-3 top-3 flex h-6 w-6 items-center justify-center rounded-full text-[var(--muted)] transition hover:bg-[var(--surface-2)] hover:text-[var(--fg)]"
              title="Hide poll"
              aria-label="Hide poll"
            >
              <X size={16} />
            </button>
            <p className="grad-text mb-2 flex items-center gap-1.5 pr-6 text-xs font-bold uppercase tracking-widest">
              {!poll.poll.closed && <BarChart3 size={14} />}
              {poll.poll.closed ? 'Poll results' : 'Live poll'}
            </p>
            <PollResults poll={poll.poll} />
          </div>
        )}

        {/* Presenter slide controls (only with a valid token) */}
        {canPresent && (
          <div className="absolute inset-x-0 bottom-6 flex justify-center">
            <div className="glass-panel flex items-center gap-1 rounded-full px-2 py-1.5 shadow-xl">
              <button
                onClick={() => changeSlide(-1)}
                disabled={atStart}
                className="btn-ghost flex h-9 w-9 items-center justify-center rounded-full text-lg leading-none disabled:opacity-40"
                title="Previous slide (←)"
                aria-label="Previous slide"
              >
                <ChevronLeft size={20} />
              </button>
              <span className="min-w-[5rem] text-center text-sm font-medium text-[var(--fg)]">
                Slide {slideIndex + 1}
                {slideCount !== null ? <span className="text-[var(--faint)]"> / {slideCount}</span> : ''}
              </span>
              <button
                onClick={() => changeSlide(1)}
                disabled={atEnd}
                className="grad-fill flex h-9 w-9 items-center justify-center rounded-full text-lg leading-none transition hover:brightness-110 disabled:opacity-40"
                title="Next slide (→)"
                aria-label="Next slide"
              >
                <ChevronRight size={20} />
              </button>
            </div>
          </div>
        )}

        {/* Floating reactions (Google-Meet style) */}
        <ReactionLayer items={reactions.items} />
      </div>

      {pip.container && createPortal(
        <CaptionOverlay lines={output.lines} label={session.targetLang} className="h-screen bg-[var(--bg)] p-5" />,
        pip.container
      )}
    </div>
  );
}
