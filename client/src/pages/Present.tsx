import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link, useParams } from 'react-router-dom';
import { MessageSquare, X, BarChart3, ChevronLeft, ChevronRight, Laptop2 } from 'lucide-react';
import { fetchSession, type SessionInfo } from '../lib/api';
import { SessionSocket, type SessionSnapshotPayload } from '../lib/ws';
import { getAdminKey } from '../lib/adminKey';
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

function SpeakerOnlyStageNotice() {
  return (
    <div className="bg-aurora flex min-h-screen flex-col items-center justify-center gap-4 px-6 text-center">
      <div className="animate-fade-up glass-panel flex max-w-md flex-col items-center gap-4 rounded-3xl px-10 py-12">
        <div className="flex h-14 w-14 items-center justify-center rounded-[var(--r-lg)] bg-info-soft text-info ring-1 ring-inset ring-info">
          <Laptop2 size={26} />
        </div>
        <h1 className="text-xl font-semibold text-[var(--fg)]">
          No projector for this speaker-only session
        </h1>
        <p className="text-sm leading-relaxed text-[var(--muted)]">
          Keep the speaker console open on the stage computer. Slides, captions, microphone, and
          translated audio all stay on that one screen.
        </p>
        <Link to="/" className="btn-ghost rounded-xl px-6 py-2.5">
          Back to Fluent
        </Link>
      </div>
    </div>
  );
}

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
  const [canPresent, setCanPresent] = useState(false);
  const [authorizationResolved, setAuthorizationResolved] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<
    'connecting' | 'authorizing' | 'connected' | 'reconnecting' | 'failed'
  >('connecting');
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const output = useTranscriptLines();
  const pip = useCaptionPip();
  const poll = usePoll(10_000); // closed polls auto-hide after 10s unless pinned
  const reactions = useReactions();
  const [dismissedPoll, setDismissedPoll] = useState<string | null>(null);
  const sockRef = useRef<SessionSocket | null>(null);

  const viewerUrl = `${location.origin}/${slug}`;
  // A stored key is only a credential to present to the server. The snapshot's
  // connection-scoped canPresent bit is the sole authority for slide controls.
  const auth = getAdminKey() ?? '';

  useEffect(() => {
    fetchSession(slug, auth || undefined)
      .then((s) => {
        setSession(s);
        setState(s.state);
        setSlideIndex(s.slideIndex);
      })
      .catch((e) => setError(String(e.message ?? e)));
  }, [auth, slug]);

  useEffect(() => {
    // Speaker-only sessions use the Host as their single stage surface. Do not
    // join this page as a viewer, since that would create audience presence.
    if (!session || session.audienceEnabled === false) return;
    let active = true;
    setCanPresent(false);
    setAuthorizationResolved(false);
    setConnectionError(null);
    setConnectionStatus('connecting');
    const sock = new SessionSocket(slug, 'viewer', auth || undefined);
    sockRef.current = sock;
    sock.onStatusChange = (connected) => {
      if (!active) return;
      // Opening a transport is not authorization. Hide controls until the next
      // snapshot explicitly grants them, including after every reconnect.
      setCanPresent(false);
      setAuthorizationResolved(false);
      setConnectionStatus(connected ? 'authorizing' : 'reconnecting');
    };
    sock.onGaveUp = (code) => {
      if (!active) return;
      setCanPresent(false);
      setAuthorizationResolved(false);
      setConnectionStatus('failed');
      setConnectionError(
        code === 4429
          ? 'Stage connection rate-limited. Wait a minute, then reload.'
          : 'Stage connection lost. Reload this page.'
      );
    };
    sock.onMessage = (msg) => {
      switch (msg.type) {
        case 'snapshot': {
          const p = msg.payload as SessionSnapshotPayload;
          setState(p.state);
          setSlideIndex(p.slideIndex);
          setCanPresent(p.canPresent === true);
          setAuthorizationResolved(true);
          setConnectionStatus('connected');
          setConnectionError(null);
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
      active = false;
      sock.close();
      sockRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth, session, slug]);

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
  if (session.audienceEnabled === false) {
    return <SpeakerOnlyStageNotice />;
  }

  const atStart = slideIndex <= 0;
  const atEnd = slideCount !== null && slideIndex >= slideCount - 1;
  const connectionLabel =
    connectionStatus === 'connecting'
      ? 'Connecting to stage…'
      : connectionStatus === 'authorizing'
        ? 'Checking stage access…'
        : connectionStatus === 'reconnecting'
          ? 'Reconnecting to stage…'
          : connectionStatus === 'failed'
            ? connectionError ?? 'Stage connection lost.'
            : canPresent
              ? 'Presenter controls connected'
              : 'Display-only stage';

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
          <div
            className={`text-[11px] ${connectionStatus === 'failed' ? 'text-error' : 'text-[var(--faint)]'}`}
          >
            {connectionLabel}
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

        {authorizationResolved && auth && !canPresent && (
          <div
            role="status"
            className="glass absolute inset-x-0 top-4 mx-auto flex w-fit max-w-[90%] items-center gap-3 rounded-full px-4 py-2 text-sm font-medium text-warning"
          >
            <span>Presenter key rejected; stage is read-only.</span>
            <Link to="/new" className="underline underline-offset-2 hover:text-[var(--fg)]">
              Presenter access
            </Link>
          </div>
        )}

        {(connectionStatus === 'reconnecting' || connectionStatus === 'failed') && (
          <div
            role="status"
            className={`glass absolute inset-x-0 top-4 mx-auto w-fit max-w-[90%] rounded-full px-4 py-2 text-sm font-medium ${
              connectionStatus === 'failed' ? 'text-error' : 'text-warning'
            }`}
          >
            {connectionLabel}
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
