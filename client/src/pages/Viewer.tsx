import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Lock, Check, Volume2, VolumeX, Headphones, X } from 'lucide-react';
import { fetchSession, REACTION_EMOJIS, type SessionInfo, type LivePoll } from '../lib/api';
import { SessionSocket } from '../lib/ws';
import { TranslatedAudioPlayer } from '../lib/audio-playback';
import { RealtimeAudioSubscriber } from '../lib/sfu-audio';
import { useTranscriptLines } from '../lib/useTranscripts';
import {
  AUDIO_SYNC_V2,
  audioSyncDebug,
  useSyncedTranscriptLines,
  type AudioMarkerPayload,
} from '../lib/audio-sync';
import { usePoll } from '../lib/usePoll';
import PollResults from '../components/PollResults';
import { getViewerProfile, saveViewerProfile, type ViewerProfile } from '../lib/viewerProfile';
import SlideViewer from '../components/SlideViewer';
import TranscriptBar from '../components/TranscriptBar';
import Onboarding from '../components/Onboarding';

/** Track portrait vs landscape so we can reflow for a 16:9 slide on phones. */
function useIsPortrait(): boolean {
  const [portrait, setPortrait] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(orientation: portrait)').matches
  );
  useEffect(() => {
    const mq = window.matchMedia('(orientation: portrait)');
    const on = () => setPortrait(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return portrait;
}

export default function Viewer() {
  const { slug = '' } = useParams();
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [profile, setProfile] = useState<ViewerProfile | null>(getViewerProfile);
  const [state, setState] = useState<string>('created');
  const [slideIndex, setSlideIndex] = useState(0);

  // Audio is OFF by default (no autoplay overlay). The first unmute click is
  // the user gesture that enables the AudioContext.
  const [activated, setActivated] = useState(false);
  const [muted, setMuted] = useState(true);
  const [volume, setVolume] = useState(1);
  const [sessionFull, setSessionFull] = useState(false);
  const [audioError, setAudioError] = useState<string | null>(null);

  const portrait = useIsPortrait();
  const poll = usePoll(10_000); // closed polls auto-hide after 10s unless pinned
  const [reactionCooldownUntil, setReactionCooldownUntil] = useState(0);
  const [reactionWarn, setReactionWarn] = useState(false);
  const [dismissedPoll, setDismissedPoll] = useState<string | null>(null);
  const playerRef = useRef<TranslatedAudioPlayer>(null!);
  if (!playerRef.current) playerRef.current = new TranslatedAudioPlayer();
  const sfuAudioRef = useRef<RealtimeAudioSubscriber>(null!);
  if (!sfuAudioRef.current) sfuAudioRef.current = new RealtimeAudioSubscriber();
  const sockRef = useRef<SessionSocket | null>(null);

  const getTranslatedAudioOffsetMs = useCallback(
    (streamId?: string) => {
      if (!activated || !session?.audio.available) return null;
      return session.audio.transport === 'sfu'
        ? sfuAudioRef.current.getAudibleAudioOffsetMs(streamId)
        : playerRef.current.getAudibleAudioOffsetMs(streamId);
    },
    [activated, session]
  );
  const translatedAudioSyncAvailable = useCallback(
    (streamId?: string) => {
      if (!activated || !session?.audio.available) return false;
      return session.audio.transport === 'sfu'
        ? sfuAudioRef.current.hasTimingConfidence(streamId)
        : playerRef.current.hasTimeline(streamId);
    },
    [activated, session]
  );
  const output = useSyncedTranscriptLines({
    enabled: AUDIO_SYNC_V2,
    fallbackMs: activated && session?.audio.transport === 'sfu' ? null : undefined,
    getAudioOffsetMs: getTranslatedAudioOffsetMs,
    isSyncAvailable: translatedAudioSyncAvailable,
    onDiagnostic: (diagnostic) => audioSyncDebug('viewer caption sync', diagnostic),
  }); // target language, top bar
  const input = useTranscriptLines(); // English subtitles, bottom bar

  useEffect(() => {
    playerRef.current.close();
    sfuAudioRef.current.close();
    setActivated(false);
    setMuted(true);
    setAudioError(null);
    fetchSession(slug)
      .then((s) => {
        setSession(s);
        setState(s.state);
        setSlideIndex(s.slideIndex);
      })
      .catch((e) => setLoadError(String(e.message ?? e)));
  }, [slug]);

  useEffect(
    () => () => {
      playerRef.current.close();
      sfuAudioRef.current.close();
    },
    []
  );

  useEffect(() => {
    if (state !== 'ended') return;
    playerRef.current.close();
    sfuAudioRef.current.close();
    sockRef.current?.close();
    sockRef.current = null;
    setActivated(false);
    setMuted(true);
  }, [state]);

  // Connect only once the viewer has entered (onboarding done) — so attendance
  // counts real attendees and carries their id/name/company.
  useEffect(() => {
    if (!session || !profile) return;
    const sock = new SessionSocket(slug, 'viewer', undefined, {
      viewerId: profile.viewerId,
      name: profile.name,
      company: profile.company,
    });
    sockRef.current = sock;
    sock.onClosed = (code) => {
      if (code === 4409) setSessionFull(true); // session viewer limit reached
    };
    sock.onGaveUp = () => setAudioError('Connection lost. Please refresh the page.');
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
          input.seed(p.recentTranscripts.filter((t) => t.kind === 'input').map((t) => t.text));
          poll.apply(p.activePoll ?? null);
          break;
        }
        case 'poll.state':
          poll.apply(msg.payload as LivePoll | null);
          break;
        case 'reaction.warn':
          setReactionWarn(true);
          setTimeout(() => setReactionWarn(false), 4000);
          break;
        case 'reaction.cooldown':
          setReactionCooldownUntil((msg.payload as { cooldownUntil: number }).cooldownUntil);
          break;
        case 'audio.marker': {
          sfuAudioRef.current.noteMarker(msg.payload as AudioMarkerPayload);
          break;
        }
        case 'audio.out': {
          const p = msg.payload as {
            data: string;
            track: string;
            streamId?: string;
            audioSeq?: number;
            audioStartMs?: number;
            durationMs?: number;
            serverSentAtMs?: number;
          };
          if (session.audio.transport !== 'sfu' && p.track === 'translated') {
            const schedule = playerRef.current.pushChunk(p.data, p);
            if (schedule.accepted && AUDIO_SYNC_V2) {
              audioSyncDebug('viewer audio scheduled', {
                streamId: schedule.streamId,
                audioSeq: schedule.audioSeq,
                backlogMs: schedule.backlogMs,
                emergencyBacklog: schedule.emergencyBacklog,
                dropped: schedule.dropped,
              });
            }
          }
          break;
        }
        case 'transcript.output': {
          const p = msg.payload as {
            text: string;
            isFinal: boolean;
            streamId?: string;
            captionSeq?: number;
            captionAudioOffsetMs?: number;
          };
          output.push(p.text, p.isFinal, p);
          break;
        }
        case 'transcript.input': {
          const p = msg.payload as { text: string; isFinal: boolean };
          input.push(p.text, p.isFinal);
          break;
        }
        case 'slide.change':
          setSlideIndex((msg.payload as { index: number }).index);
          break;
        case 'session.state':
          setState((msg.payload as { state: string }).state);
          break;
        case 'session.error': {
          const p = msg.payload as { scope?: string; message?: string };
          setAudioError(`Translation unavailable: ${p.message ?? 'unknown error'}`);
          break;
        }
      }
    };
    sock.connect();
    return () => sock.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, slug, profile]);

  // First gesture: enable the audio context and start playing (unmuted).
  const activateAudio = async () => {
    const currentSession = session;
    if (!currentSession) return;
    if (!currentSession.audio.available) {
      setAudioError('Translated audio is not enabled for this session.');
      return;
    }
    try {
      setAudioError(null);
      if (currentSession.audio.transport === 'sfu') {
        await sfuAudioRef.current.connect(slug);
        sfuAudioRef.current.setVolume(volume);
        sfuAudioRef.current.setMuted(false);
      } else {
        await playerRef.current.enable();
        playerRef.current.setVolume(volume);
        playerRef.current.setMuted(false);
      }
      setActivated(true);
      setMuted(false);
    } catch (e) {
      setAudioError(`Audio unavailable: ${String((e as Error).message ?? e)}`);
    }
  };

  const toggleMute = () => {
    const next = !muted;
    playerRef.current.setMuted(next);
    sfuAudioRef.current.setMuted(next);
    setMuted(next);
  };

  const vote = (optionIndex: number) => {
    if (!poll.poll || poll.poll.closed) return;
    sockRef.current?.send('poll.vote', { pollId: poll.poll.id, optionIndex });
    poll.setMyVote(optionIndex);
  };

  const react = (emoji: string) => {
    if (Date.now() < reactionCooldownUntil) return;
    sockRef.current?.send('reaction', { emoji });
  };

  if (loadError) {
    return (
      <div className="bg-aurora flex min-h-screen items-center justify-center text-[var(--muted)]">
        Session not found.
      </div>
    );
  }
  if (!session) {
    return (
      <div className="bg-aurora flex min-h-screen items-center justify-center text-[var(--faint)]">
        Loading…
      </div>
    );
  }

  // Onboarding gate — collect (optional) name/company, then enter the room.
  if (!profile) {
    return (
      <Onboarding
        title={session.title}
        targetLang={session.targetLang}
        onEnter={(info) => setProfile(saveViewerProfile(info))}
      />
    );
  }

  if (sessionFull) {
    return (
      <div className="bg-aurora flex min-h-screen flex-col items-center justify-center gap-4 px-6 text-center">
        <div className="animate-fade-up glass-panel flex max-w-sm flex-col items-center gap-4 rounded-3xl px-10 py-12">
          <div className="flex h-14 w-14 items-center justify-center rounded-[var(--r-lg)] bg-info-soft text-info ring-1 ring-inset ring-info">
            <Lock size={26} />
          </div>
          <h1 className="text-xl font-semibold text-[var(--fg)]">This session is full</h1>
          <p className="text-sm text-[var(--muted)]">
            This session has reached its viewer limit. Ask the host when a place becomes available.
          </p>
          <Link to="/" className="btn-primary rounded-xl px-6 py-2.5">
            Back to Fluent
          </Link>
        </div>
      </div>
    );
  }

  if (state === 'ended') {
    return (
      <div className="bg-aurora flex min-h-screen flex-col items-center justify-center gap-5 px-6 text-center">
        <div className="animate-fade-up glass-panel flex flex-col items-center gap-5 rounded-3xl px-10 py-12">
          <div className="flex h-14 w-14 items-center justify-center rounded-[var(--r-lg)] bg-[var(--surface-2)] text-[var(--cyan)] ring-1 ring-inset ring-[var(--border)]">
            <Check size={26} />
          </div>
          <h1 className="text-2xl font-semibold text-[var(--fg)]">
            {session.title || 'This talk'} has ended
          </h1>
          <p className="-mt-2 text-[var(--faint)]">Thanks for joining.</p>
          <Link to={`/${slug}/transcript`} className="btn-primary rounded-xl px-6 py-2.5">
            View the full transcript
          </Link>
        </div>
      </div>
    );
  }

  // Primary control: always labeled (icon + text), never icon-only — `title`
  // alone is dead on touch.
  const audioControl = !session.audio.available ? (
    <div className="flex items-center gap-2 rounded-full bg-surface2 px-3.5 py-2 text-xs font-medium text-[var(--muted)] ring-1 ring-inset ring-[var(--border)]">
      <Headphones size={16} /> Captions only
    </div>
  ) : !activated ? (
    session.presentationMode === 'in_person' ? (
      <button
        onClick={() => void activateAudio()}
        aria-label="Listen to the translated audio on this device"
        className="btn-primary animate-attention flex items-center gap-2 rounded-full px-5 py-3 text-sm font-semibold shadow-2xl"
      >
        <Headphones size={18} /> Listen here
      </button>
    ) : (
      <button
        onClick={() => void activateAudio()}
        autoFocus
        aria-label="Turn on translated audio"
        className="btn-primary animate-attention flex items-center gap-2 rounded-full px-5 py-3 text-sm font-semibold shadow-2xl"
      >
        <Volume2 size={18} /> Tap to unmute
      </button>
    )
  ) : (
    <div className="flex items-center gap-2 rounded-full bg-surface2 px-3 py-2 ring-1 ring-inset ring-[var(--border)]">
      <button
        onClick={toggleMute}
        aria-label={muted ? 'Unmute' : 'Mute'}
        className="flex items-center gap-2 text-[var(--fg)] transition hover:text-[var(--cyan)]"
      >
        {muted ? <VolumeX size={20} /> : <Volume2 size={20} />}
        <span className="text-sm font-medium">{muted ? 'Muted' : 'Audio'}</span>
      </button>
      <input
        type="range"
        min={0}
        max={1}
        step={0.05}
        value={volume}
        onChange={(e) => {
          const v = Number(e.target.value);
          setVolume(v);
          playerRef.current.setVolume(v);
          sfuAudioRef.current.setVolume(v);
        }}
        aria-label="Volume"
        className="w-16 accent-[var(--cyan)] sm:w-24"
      />
    </div>
  );

  // Status overlays that belong directly over the slide pixels.
  const statusOverlays = (
    <>
      {state === 'created' && (
        <div className="bg-grad-soft absolute inset-0 flex flex-col items-center justify-center gap-2 bg-[var(--bg)] px-4 text-center">
          <span className="live-dot mb-1" />
          <p className="text-base font-medium text-[var(--muted)] sm:text-xl">Waiting for the presenter…</p>
        </div>
      )}
      {state === 'paused' && (
        <div className="glass absolute inset-x-0 top-3 mx-auto flex w-fit items-center gap-2 rounded-full px-3 py-1 text-xs font-medium text-warning sm:text-sm">
          <span className="h-2 w-2 rounded-full bg-warning" /> Paused
        </div>
      )}
      {state === 'reconnecting' && (
        <div className="glass absolute inset-x-0 top-3 mx-auto flex w-fit items-center gap-2 rounded-full px-3 py-1 text-xs font-medium text-warning sm:text-sm">
          <span className="h-2 w-2 animate-ping rounded-full bg-warning" /> Reconnecting…
        </div>
      )}
    </>
  );

  // Reactions: pushed to the right of the control zone (flex), so they can never
  // collide with the audio control.
  const reactionControls =
    Date.now() < reactionCooldownUntil ? (
      <div className="ml-auto rounded-full bg-surface2 px-3 py-1.5 text-xs text-[var(--muted)] ring-1 ring-inset ring-[var(--border)]">
        Reactions paused
      </div>
    ) : (
      <div className="ml-auto flex flex-col items-end gap-1">
        {reactionWarn && (
          <span className="rounded-full bg-warning-soft px-2.5 py-0.5 text-[11px] text-warning ring-1 ring-inset ring-warning">
            Easy on the reactions
          </span>
        )}
        <div className="flex items-center gap-0.5 rounded-full bg-surface2 px-2 py-1 ring-1 ring-inset ring-[var(--border)]">
          {REACTION_EMOJIS.map((e) => (
            <button
              key={e}
              onClick={() => react(e)}
              aria-label={`React ${e}`}
              className="emoji-btn px-1 py-1 text-xl sm:px-1.5"
            >
              {e}
            </button>
          ))}
        </div>
      </div>
    );

  // The whole bottom control zone (audio primary + reactions). Background varies:
  // a scrim when it overlays the slide (landscape), solid when it's an in-flow
  // bar (portrait, where the slide is only a thin strip).
  const controlZone = (overlay: boolean) => (
    <div
      className={
        overlay
          ? 'absolute inset-x-0 bottom-0 z-10 flex items-center gap-2 bg-scrim px-3 pb-3 pt-8'
          : 'flex items-center gap-2 border-t border-[var(--border)] bg-surface px-3 py-2'
      }
    >
      {audioControl}
      {reactionControls}
    </div>
  );

  const pollCard = poll.poll && poll.poll.id !== dismissedPoll && (
    <div className="glass-panel relative animate-fade-up rounded-[var(--r-lg)] p-3.5 shadow-2xl">
      <button
        onClick={() => setDismissedPoll(poll.poll!.id)}
        aria-label="Hide poll"
        className="absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded-full text-[var(--muted)] transition hover:bg-[var(--surface-2)] hover:text-[var(--fg)]"
      >
        <X size={16} />
      </button>
      {poll.myVote === null && !poll.poll.closed ? (
        <>
          <p className="mb-2.5 pr-6 font-semibold text-[var(--fg)]">{poll.poll.question}</p>
          <div className="space-y-1.5">
            {poll.poll.options.map((opt, i) => (
              <button
                key={i}
                onClick={() => vote(i)}
                className="btn-ghost w-full rounded-[var(--r-md)] px-3 py-2 text-left text-sm text-[var(--fg)]"
              >
                {opt}
              </button>
            ))}
          </div>
        </>
      ) : (
        <PollResults poll={poll.poll} myVote={poll.myVote} />
      )}
    </div>
  );

  const audioErrorBanner = audioError && (
    <div className="rounded-[var(--r-md)] bg-error-soft px-3 py-2 text-center text-xs text-error shadow-xl ring-1 ring-inset ring-error">
      {audioError}
    </div>
  );

  const slide = (
    <SlideViewer slideType={session.slideType} slideUrl={session.slideUrl} slideIndex={slideIndex} />
  );
  const targetBar = (size: 'fill' | 'lg') => (
    <TranscriptBar lines={output.lines} label={session.targetLang} position="top" accent size={size} />
  );
  const sourceBar = <TranscriptBar lines={input.lines} label="EN" position="bottom" size="sm" />;

  // Portrait (phones): the slide is a thin 16:9 strip pinned at the top, so the
  // control zone is a real bottom bar (in-flow, never overlaps) and the poll
  // floats over the roomy translation area rather than the cramped strip.
  if (portrait) {
    return (
      <div className="flex h-[100dvh] flex-col bg-[var(--bg)]">
        <div className="relative aspect-video w-full shrink-0 bg-[var(--surface-2)]">
          {slide}
          {statusOverlays}
        </div>
        <div className="relative flex min-h-0 flex-1 flex-col">
          {targetBar('fill')}
          {(pollCard || audioErrorBanner) && (
            <div className="absolute inset-x-3 bottom-3 z-20 flex flex-col gap-2">
              {audioErrorBanner}
              {pollCard}
            </div>
          )}
        </div>
        {sourceBar}
        {controlZone(false)}
      </div>
    );
  }

  // Landscape / desktop: big translation on top, slide fills the center; the
  // control zone overlays the slide bottom (scrim), poll card sits above it.
  return (
    <div className="relative flex h-[100dvh] flex-col bg-[var(--bg)]">
      {targetBar('lg')}
      <div className="relative min-h-0 flex-1 bg-[var(--surface-2)]">
        {slide}
        {statusOverlays}
        {pollCard && <div className="absolute bottom-[4.5rem] left-3 z-20 w-72 max-w-[70%]">{pollCard}</div>}
        {audioErrorBanner && <div className="absolute bottom-[4.75rem] right-3 z-30 max-w-xs">{audioErrorBanner}</div>}
        {controlZone(true)}
      </div>
      {sourceBar}
    </div>
  );
}
