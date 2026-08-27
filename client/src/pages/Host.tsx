import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useParams } from 'react-router-dom';
import {
  Play, Pause, Square, RotateCw, ChevronLeft, ChevronRight, Users, Circle,
  MonitorPlay, PictureInPicture2, X, Check, Plus, Volume2, Headphones, Smartphone,
  Mic, MicOff,
} from 'lucide-react';

type Routing = 'room' | 'headphones' | 'viewers';
type HostTab = 'setup' | 'polls' | 'audience';
import {
  fetchSession,
  fetchAnalytics,
  type SessionInfo,
  type Analytics,
} from '../lib/api';
import { getAdminKey } from '../lib/adminKey';
import { SessionSocket } from '../lib/ws';
import { MicCapture, listAudioDevices, DSP_OFF, type DspConfig } from '../lib/audio-capture';
import { TranslatedAudioPlayer } from '../lib/audio-playback';
import { useTranscriptLines } from '../lib/useTranscripts';
import { AUDIO_SYNC_V2, audioSyncDebug, useSyncedTranscriptLines } from '../lib/audio-sync';
import AdminKeyGate from '../components/AdminKeyGate';
import SlideViewer from '../components/SlideViewer';
import TranscriptBar from '../components/TranscriptBar';
import QrCode from '../components/QrCode';
import CaptionOverlay from '../components/CaptionOverlay';
import ThemeToggle from '../components/ThemeToggle';
import PollResults from '../components/PollResults';
import ReactionLayer from '../components/ReactionLayer';
import { useCaptionPip } from '../lib/captionPip';
import { usePoll } from '../lib/usePoll';
import { useReactions } from '../lib/useReactions';
import type { LivePoll } from '../lib/api';

function fmtDur(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
}

const ANALYTICS_REFRESH_MS = 10 * 60 * 1000;
const EMPTY_POLL_OPTIONS = ['', ''];
const EMPTY_POLL_CORRECT = [false, false];

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-xl bg-[var(--surface-2)] px-3 py-2 ring-1 ring-inset ring-[var(--border)]">
      <div className="text-lg font-semibold text-[var(--fg)]">{value}</div>
      <div className="text-[11px] uppercase tracking-wide text-[var(--faint)]">{label}</div>
    </div>
  );
}

// Room mode enables echo cancellation ONLY (the loop-breaker); noise
// suppression / AGC stay off since those are what degrade translation.
// Headphone setups can still opt into full browser DSP via the toggle.
function dspFor(roomMode: boolean, browserDsp: boolean): DspConfig {
  return roomMode
    ? { echoCancellation: true, noiseSuppression: false, autoGainControl: false }
    : browserDsp
      ? { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      : DSP_OFF;
}

export default function Host() {
  return (
    <AdminKeyGate>
      <HostInner />
    </AdminKeyGate>
  );
}

function HostInner() {
  const { slug = '' } = useParams();
  const auth = getAdminKey() ?? '';
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [state, setState] = useState<string>('created');
  const [slideIndex, setSlideIndex] = useState(0);
  const [slideCount, setSlideCount] = useState<number | null>(null);
  const [viewerCount, setViewerCount] = useState(0);
  const [wsConnected, setWsConnected] = useState(false);

  const [inputs, setInputs] = useState<MediaDeviceInfo[]>([]);
  const [outputs, setOutputs] = useState<MediaDeviceInfo[]>([]);
  const [micId, setMicId] = useState<string>('');
  const [speakerId, setSpeakerId] = useState<string>('');
  const [micLevel, setMicLevel] = useState(0);
  const [micReady, setMicReady] = useState(false);
  const [micError, setMicError] = useState<string | null>(null);
  const [micMuted, setMicMuted] = useState(false);
  const [browserDsp, setBrowserDsp] = useState(false);
  const [monitor, setMonitor] = useState(false); // local monitoring, default OFF (§4.3)
  const [roomMode, setRoomMode] = useState(false); // no-earphones room: AEC + PA feed + gate
  const [halfDuplex, setHalfDuplex] = useState(false); // mute mic while translation plays (opt-in)
  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  const [analyticsRefreshing, setAnalyticsRefreshing] = useState(false);
  const [analyticsUpdatedAt, setAnalyticsUpdatedAt] = useState<number | null>(null);
  const [audioError, setAudioError] = useState<string | null>(null);
  const [translationError, setTranslationError] = useState<string | null>(null);
  const pip = useCaptionPip();
  const poll = usePoll();
  const reactions = useReactions();
  const [pollQuestion, setPollQuestion] = useState('');
  const [pollOptions, setPollOptions] = useState<string[]>(EMPTY_POLL_OPTIONS);
  const [pollCorrect, setPollCorrect] = useState<boolean[]>(EMPTY_POLL_CORRECT); // quiz answer flags
  // Console layout: a pinned live-critical band + tabbed body.
  const [tab, setTab] = useState<HostTab>('setup');
  const [confirmStop, setConfirmStop] = useState(false);
  const [confirmDeletePoll, setConfirmDeletePoll] = useState(false);
  const [routing, setRouting] = useState<Routing>('viewers');
  const [advancedAudioOpen, setAdvancedAudioOpen] = useState(false);
  const hasSession = !!session;

  const sockRef = useRef<SessionSocket | null>(null);
  const micRef = useRef<MicCapture | null>(null);
  const micIdRef = useRef(micId);
  micIdRef.current = micId;
  const micMutedRef = useRef(micMuted);
  micMutedRef.current = micMuted;
  const stateRef = useRef(state);
  stateRef.current = state;
  const browserDspRef = useRef(browserDsp);
  browserDspRef.current = browserDsp;
  const recoverMicRef = useRef<(reason: string) => void>(() => {});
  const monitorRef = useRef<TranslatedAudioPlayer | null>(null);
  const monitorOnRef = useRef(false);
  monitorOnRef.current = monitor;
  const roomModeRef = useRef(false);
  roomModeRef.current = roomMode;
  const analyticsRefreshInFlightRef = useRef(false);

  const output = useSyncedTranscriptLines({
    enabled: AUDIO_SYNC_V2,
    getAudioOffsetMs: (streamId) => monitorRef.current?.getAudibleAudioOffsetMs(streamId) ?? null,
    isSyncAvailable: (streamId) =>
      (monitorOnRef.current || roomModeRef.current) && (monitorRef.current?.hasTimeline(streamId) ?? false),
    onDiagnostic: (diagnostic) => audioSyncDebug('host caption sync', diagnostic),
  });
  const input = useTranscriptLines();

  useEffect(
    () => () => {
      monitorRef.current?.close();
      monitorRef.current = null;
    },
    [slug]
  );

  const viewerUrl = `${location.origin}/${slug}`;

  const selectMicId = useCallback((deviceId: string) => {
    micIdRef.current = deviceId;
    setMicId(deviceId);
  }, []);

  const refreshAudioDevices = useCallback(async (prompt = false) => {
    const devices = await listAudioDevices({ prompt });
    setInputs(devices.inputs);
    setOutputs(devices.outputs);
    return devices;
  }, []);

  useEffect(() => {
    void fetchSession(slug).then((s) => {
      setSession(s);
      setState(s.state);
      setSlideIndex(s.slideIndex);
    });
    void refreshAudioDevices(true).then(({ inputs }) => {
      if (!micIdRef.current && inputs[0]) selectMicId(inputs[0].deviceId);
    });
  }, [refreshAudioDevices, selectMicId, slug]);

  // Host WS — authenticates with the admin key in the hello message.
  useEffect(() => {
    if (!hasSession) return;
    const sock = new SessionSocket(slug, 'host', auth || undefined);
    sock.onStatusChange = setWsConnected;
    sock.onGaveUp = (code) =>
      setTranslationError(`Lost connection to the server (code ${code}). Please reload this page.`);
    sock.onMessage = (msg) => {
      switch (msg.type) {
        case 'snapshot': {
          const p = msg.payload as { state: string; slideIndex: number; activePoll: LivePoll | null };
          setState(p.state);
          setSlideIndex(p.slideIndex);
          poll.apply(p.activePoll ?? null);
          break;
        }
        case 'poll.state':
          poll.apply(msg.payload as LivePoll | null);
          break;
        case 'reaction':
          reactions.push((msg.payload as { emoji: string }).emoji);
          break;
        case 'session.state': {
          const next = (msg.payload as { state: string }).state;
          setState(next);
          if (next === 'live') setTranslationError(null); // recovered
          break;
        }
        case 'session.error':
          setTranslationError((msg.payload as { message?: string }).message ?? 'translation unavailable');
          break;
        case 'presence':
          setViewerCount((msg.payload as { viewerCount: number }).viewerCount);
          break;
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
        case 'audio.out': {
          // Play translated audio on the host when monitoring OR in Room mode
          // (where the host output is the room PA feed).
          if (monitorOnRef.current || roomModeRef.current) {
            const p = msg.payload as {
              data: string;
              streamId?: string;
              audioSeq?: number;
              audioStartMs?: number;
              durationMs?: number;
              serverSentAtMs?: number;
            };
            const schedule = monitorRef.current?.pushChunk(p.data, p);
            if (schedule?.accepted && AUDIO_SYNC_V2) {
              audioSyncDebug('host audio scheduled', {
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
      }
    };
    sock.connect();
    sockRef.current = sock;
    return () => {
      if (sockRef.current === sock) sockRef.current = null;
      sock.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth, hasSession, slug]);

  // Mic graph: acquired in the lobby so the VU meter works before Start;
  // frames stream to the server only while state is 'live'.
  const ensureMic = useCallback(async (preferredDeviceId = micIdRef.current) => {
    if (micRef.current) return micRef.current;
    const mic = new MicCapture({
      deviceId: preferredDeviceId || undefined,
      dsp: dspFor(roomModeRef.current, browserDspRef.current),
      onChunk: (b64) =>
        sockRef.current?.send('audio.in', {
          data: b64,
          ...(AUDIO_SYNC_V2 ? { clientSentAtMs: Date.now() } : {}),
        }),
      onLevel: setMicLevel,
      onEnded: () => recoverMicRef.current('ended'),
    });
    mic.setMuted(micMutedRef.current);
    try {
      await mic.start();
      micRef.current = mic;
      setMicReady(true);
      setMicError(null);
      // Re-enumerate now that permission is granted (labels become visible).
      const { inputs } = await refreshAudioDevices(false);
      if (!micIdRef.current && inputs[0]) selectMicId(inputs[0].deviceId);
      return mic;
    } catch (e) {
      setMicError(`Microphone error: ${String((e as Error).message ?? e)}`);
      return null;
    }
  }, [refreshAudioDevices, selectMicId]);

  useEffect(() => {
    void ensureMic();
    return () => {
      micRef.current?.stop();
      micRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const recoverMic = useCallback(async (reason: string) => {
    const wasStreaming = micRef.current?.streaming ?? stateRef.current === 'live';
    const { inputs } = await refreshAudioDevices(false);
    const selectedId = micIdRef.current;
    const selectedAvailable = !!selectedId && inputs.some((d) => d.deviceId === selectedId);
    const nextDeviceId = selectedAvailable ? selectedId : inputs[0]?.deviceId ?? '';

    if (reason === 'devicechange' && selectedAvailable && micRef.current) return;

    if (!nextDeviceId) {
      micRef.current?.stop();
      micRef.current = null;
      setMicReady(false);
      setMicLevel(0);
      setMicError('Microphone disconnected. Connect or select a microphone to resume captions.');
      return;
    }

    if (nextDeviceId !== selectedId) selectMicId(nextDeviceId);

    try {
      let mic = micRef.current;
      if (mic) await mic.switchDevice(nextDeviceId);
      else mic = await ensureMic(nextDeviceId);
      if (!mic) return;
      mic.setMuted(micMutedRef.current);
      mic.streaming = wasStreaming;
      setMicReady(true);
      setMicError(null);
    } catch (e) {
      setMicReady(false);
      setMicLevel(0);
      const prefix =
        reason === 'ended'
          ? 'The selected microphone stopped'
          : 'Microphone changed but could not be resumed';
      setMicError(`${prefix}: ${String((e as Error).message ?? e)}`);
    }
  }, [ensureMic, refreshAudioDevices, selectMicId]);

  useEffect(() => {
    recoverMicRef.current = (reason: string) => {
      void recoverMic(reason);
    };
  }, [recoverMic]);

  // Refresh and recover when hardware changes. If the selected mic disappeared,
  // automatically fall back to the first available input and keep streaming.
  useEffect(() => {
    const md = navigator.mediaDevices;
    if (!md?.addEventListener) return;
    const refresh = () => {
      void recoverMic('devicechange');
    };
    md.addEventListener('devicechange', refresh);
    return () => md.removeEventListener('devicechange', refresh);
  }, [recoverMic]);

  useEffect(() => {
    micRef.current?.setMuted(micMuted);
  }, [micMuted]);

  // Re-acquire the mic with new DSP when Room mode or the DSP toggle changes.
  useEffect(() => {
    void micRef.current?.setDsp(dspFor(roomMode, browserDsp));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomMode, browserDsp]);

  // Half-duplex gate: while translated audio is playing on the host (the room
  // PA feed), drop mic frames + a short hangover so the echo never re-enters
  // the model. Backs up AEC for loud rooms / distant mics.
  useEffect(() => {
    if (!roomMode || !halfDuplex) {
      micRef.current?.setGated(false);
      return;
    }
    let hangoverUntil = 0;
    const id = window.setInterval(() => {
      const now = performance.now();
      // Generous hangover so the echo tail (incl. media-element output latency)
      // is fully covered after each phrase before the mic reopens.
      if (monitorRef.current?.isPlaying()) hangoverUntil = now + 700;
      micRef.current?.setGated(now < hangoverUntil);
    }, 80);
    return () => {
      clearInterval(id);
      micRef.current?.setGated(false);
    };
  }, [roomMode, halfDuplex]);

  const switchMic = async (deviceId: string) => {
    const previousId = micIdRef.current;
    const wasStreaming = micRef.current?.streaming ?? stateRef.current === 'live';
    selectMicId(deviceId);
    try {
      let mic = micRef.current;
      if (mic) await mic.switchDevice(deviceId || undefined);
      else mic = await ensureMic(deviceId);
      if (!mic) return;
      mic.setMuted(micMutedRef.current);
      mic.streaming = wasStreaming;
      setMicReady(true);
      setMicError(null);
    } catch (e) {
      selectMicId(previousId);
      setMicError(`Microphone error: ${String((e as Error).message ?? e)}`);
      void recoverMic('switch-failed');
    }
  };

  const toggleMicMute = async () => {
    const next = !micMutedRef.current;
    micMutedRef.current = next;
    setMicMuted(next);
    if (next) {
      micRef.current?.setMuted(true);
      return;
    }
    const mic = micRef.current ?? (await ensureMic());
    if (!mic) return;
    mic.setMuted(false);
    if (stateRef.current === 'live') mic.streaming = true;
  };

  const sendControl = (action: 'start' | 'pause' | 'stop' | 'kill_gemini_test') =>
    sockRef.current?.send('control', { action });

  const launchPoll = () => {
    const pairs = pollOptions
      .map((o, i) => ({ o: o.trim(), correct: pollCorrect[i] }))
      .filter((p) => p.o);
    if (!pollQuestion.trim() || pairs.length < 2) return;
    const options = pairs.map((p) => p.o);
    const correctOptions = pairs.map((p, i) => (p.correct ? i : -1)).filter((i) => i >= 0);
    sockRef.current?.send('poll.open', { question: pollQuestion.trim(), options, correctOptions });
    setPollQuestion('');
    setPollOptions(EMPTY_POLL_OPTIONS);
    setPollCorrect(EMPTY_POLL_CORRECT);
  };
  const pollAction = (type: 'poll.close' | 'poll.hide' | 'poll.delete' | 'poll.pin', pinned?: boolean) => {
    if (poll.poll) sockRef.current?.send(type, { pollId: poll.poll.id, pinned });
  };
  const addOption = () => {
    setPollOptions((o) => [...o, '']);
    setPollCorrect((c) => [...c, false]);
  };
  const removeOption = (i: number) => {
    setPollOptions((o) => o.filter((_, j) => j !== i));
    setPollCorrect((c) => c.filter((_, j) => j !== i));
  };

  const onStart = async () => {
    const mic = await ensureMic();
    if (!mic) return;
    if (roomMode || monitor) {
      try {
        await ensureHostPlayer();
      } catch {
        if (roomMode) return;
      }
    }
    mic.streaming = true;
    sendControl('start');
  };
  const onPause = () => {
    if (micRef.current) micRef.current.streaming = false;
    sendControl('pause');
  };
  const onResume = async () => {
    const mic = await ensureMic();
    if (roomMode || monitor) {
      try {
        await ensureHostPlayer();
      } catch {
        if (roomMode) return;
      }
    }
    if (mic) mic.streaming = true;
    sendControl('start');
  };
  const onStop = () => {
    if (micRef.current) micRef.current.streaming = false;
    sendControl('stop');
  };

  const ensureHostPlayer = async () => {
    try {
      if (!monitorRef.current) monitorRef.current = new TranslatedAudioPlayer();
      await monitorRef.current.enable();
      if (speakerId) await monitorRef.current.setSink(speakerId);
      setAudioError(null);
    } catch (e) {
      setAudioError(`Audio output error: ${String((e as Error).message ?? e)}`);
      throw e;
    }
  };

  // One guided choice derives the same roomMode/monitor/DSP state the four
  // toggles produced — the DSP math (dspFor, AEC, half-duplex) is unchanged:
  //   room       → PA feed on this machine + echo cancellation (roomMode)
  //   headphones → private monitor, no AEC drama (monitor)
  //   viewers    → host silent; audio is per-device (neither)
  // `ensurePlayer` is false on the initial auto-select (the output player is
  // enabled at Start, as before) and true when the host picks during setup.
  const applyRouting = async (r: Routing, ensurePlayer = true) => {
    setRouting(r);
    setRoomMode(r === 'room');
    setMonitor(r === 'headphones');
    if (ensurePlayer && r !== 'viewers') {
      try {
        await ensureHostPlayer();
      } catch {
        /* error surfaced via audioError; routing choice still stands */
      }
    }
  };

  const setConsoleTab = (next: HostTab) => {
    setTab(next);
  };

  // Auto-select routing from the session's mode once it loads (in-person hosts
  // are the room PA; remote hosts stay silent). Replaces the old roomMode auto-
  // effect; the player is still enabled at Start, not here.
  useEffect(() => {
    if (!session) return;
    void applyRouting(session.presentationMode === 'in_person' ? 'room' : 'viewers', false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  useEffect(() => {
    if (state !== 'live' && micRef.current) {
      micRef.current.streaming = false;
    }
  }, [state]);

  // Drop the two-step confirmations whenever the relevant state changes.
  useEffect(() => {
    if (state !== 'live' && state !== 'paused') setConfirmStop(false);
  }, [state]);
  useEffect(() => {
    if (!poll.poll) setConfirmDeletePoll(false);
  }, [poll.poll]);

  const changeSlide = (delta: number) => {
    const next = Math.max(0, slideIndex + delta);
    const capped = slideCount !== null ? Math.min(next, slideCount - 1) : next;
    setSlideIndex(capped);
    sockRef.current?.send('slide.change', { index: capped });
  };

  // Keyboard slide nav
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      if (e.key === 'ArrowRight') changeSlide(1);
      if (e.key === 'ArrowLeft') changeSlide(-1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slideIndex, slideCount]);

  // Attendance analytics is intentionally low-frequency; live viewer count is
  // already provided over the host websocket.
  const refreshAnalytics = useCallback(async () => {
    if (analyticsRefreshInFlightRef.current) return;
    analyticsRefreshInFlightRef.current = true;
    setAnalyticsRefreshing(true);
    try {
      setAnalytics(await fetchAnalytics(auth, slug));
      setAnalyticsUpdatedAt(Date.now());
    } catch {
      /* transient — keep the last good snapshot */
    } finally {
      analyticsRefreshInFlightRef.current = false;
      setAnalyticsRefreshing(false);
    }
  }, [slug, auth]);

  useEffect(() => {
    void refreshAnalytics();
    const id = window.setInterval(() => void refreshAnalytics(), ANALYTICS_REFRESH_MS);
    return () => clearInterval(id);
  }, [refreshAnalytics]);

  // We route monitor/PA audio through a media element, so element setSinkId
  // counts too (broader support than AudioContext.setSinkId).
  const supportsSinkId =
    'setSinkId' in HTMLMediaElement.prototype || 'setSinkId' in AudioContext.prototype;

  if (!session) {
    return (
      <div className="bg-aurora flex min-h-screen items-center justify-center text-[var(--faint)]">
        Loading…
      </div>
    );
  }

  const stateStyle =
    state === 'live'
      ? 'grad-border text-[var(--fg)] ring-transparent'
      : state === 'reconnecting'
        ? 'bg-warning-soft text-warning ring-warning'
        : state === 'paused'
          ? 'bg-warning-soft text-warning ring-warning'
          : state === 'ended'
            ? 'bg-[var(--muted)]/15 text-[var(--muted)] ring-[var(--border)]'
            : 'bg-[var(--surface-2)] text-[var(--muted)] ring-[var(--border)]';

  return (
    <div className="flex h-screen bg-[var(--bg)]">
      {/* Main column: same layout as viewer */}
      <div className="hidden min-w-0 flex-1 flex-col md:flex">
        <TranscriptBar lines={output.lines} label={session.targetLang} position="top" accent size="lg" />
        <div className="relative min-h-0 flex-1 bg-[var(--surface-2)]">
          <SlideViewer
            slideType={session.slideType}
            slideUrl={session.slideUrl}
            slideIndex={slideIndex}
            onSlideCount={setSlideCount}
          />
          {state === 'reconnecting' && (
            <div className="glass absolute inset-x-0 top-4 mx-auto flex w-fit items-center gap-2 rounded-full px-4 py-1.5 text-sm font-medium text-warning">
              <span className="h-2 w-2 animate-ping rounded-full bg-warning" /> Reconnecting to translator…
            </div>
          )}
          {translationError && (
            <div className="glass absolute inset-x-0 top-4 mx-auto flex w-fit max-w-[90%] items-center gap-2 rounded-full px-4 py-1.5 text-sm font-medium text-error">
              <span className="h-2 w-2 rounded-full bg-error" /> {translationError}
            </div>
          )}
          <ReactionLayer items={reactions.items} />
        </div>
        <TranscriptBar lines={input.lines} label="EN" position="bottom" size="sm" />
      </div>

      {/* Control rail: pinned live-critical band + tabbed body */}
      <aside className="glass-panel flex w-full shrink-0 flex-col text-[var(--fg)] md:w-[22rem] md:border-l md:border-[var(--border)]">
        {/* 1) Pinned band — transport + slide nav stay visible without scrolling */}
        <div className="shrink-0 space-y-3 border-b border-[var(--border)] p-4">
          <div className="flex items-start justify-between gap-2">
            <h1 className="truncate text-lg font-semibold text-[var(--fg)]">{session.title || 'Untitled talk'}</h1>
            <ThemeToggle />
          </div>
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-1.5 text-xs">
              <span className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 font-semibold uppercase tracking-wide ring-1 ring-inset ${stateStyle}`}>
                {state === 'live' && <span className="live-dot" />}
                <span className={state === 'live' ? 'grad-text' : undefined}>{state}</span>
              </span>
              <span className="rounded-full bg-[var(--surface-2)] px-2.5 py-1 text-[var(--muted)] ring-1 ring-inset ring-[var(--border)]">
                → {session.targetLang}
              </span>
              <span className="flex items-center gap-1.5 rounded-full bg-[var(--surface-2)] px-2.5 py-1 text-[var(--muted)] ring-1 ring-inset ring-[var(--border)]">
                <Circle size={8} className={wsConnected ? 'fill-current text-[var(--cyan)]' : 'fill-current text-[var(--faint)]'} />
                {wsConnected ? 'live' : 'offline'}
              </span>
              <span className="flex items-center gap-1 rounded-full bg-[var(--surface-2)] px-2.5 py-1 text-[var(--muted)] ring-1 ring-inset ring-[var(--border)]">
                <Users size={13} /> {viewerCount}
              </span>
            </div>

            {/* Transport */}
            <div className="flex gap-2">
              {state === 'created' && (
                <button
                  onClick={onStart}
                  className="btn-primary flex flex-1 items-center justify-center gap-2 rounded-[var(--r-md)] py-2.5"
                >
                  <Play size={18} /> Start
                </button>
              )}
              {state === 'live' && (
                <button onClick={onPause} className="flex flex-1 items-center justify-center gap-2 rounded-[var(--r-md)] bg-warning-soft py-2.5 font-semibold text-warning ring-1 ring-inset ring-warning transition hover:brightness-110">
                  <Pause size={18} /> Pause
                </button>
              )}
              {state === 'paused' && (
                <button onClick={onResume} className="btn-primary flex flex-1 items-center justify-center gap-2 rounded-[var(--r-md)] py-2.5">
                  <Play size={18} /> Resume
                </button>
              )}
              {state === 'ended' && (
                <button onClick={onResume} className="btn-primary flex flex-1 items-center justify-center gap-2 rounded-[var(--r-md)] py-2.5">
                  <RotateCw size={18} /> Restart session
                </button>
              )}
              {(state === 'live' || state === 'paused') &&
                (confirmStop ? (
                  <button onClick={onStop} className="flex flex-1 items-center justify-center gap-2 rounded-[var(--r-md)] bg-error-soft py-2.5 font-semibold text-error ring-1 ring-inset ring-error">
                    Confirm stop
                  </button>
                ) : (
                  <button onClick={() => setConfirmStop(true)} className="flex flex-1 items-center justify-center gap-2 rounded-[var(--r-md)] bg-error-soft py-2.5 font-semibold text-error ring-1 ring-inset ring-error transition hover:brightness-110">
                    <Square size={18} /> Stop…
                  </button>
                ))}
            </div>
          </div>

          {/* Manual mic mute stays independent from pause/resume. */}
          <button
            type="button"
            onClick={() => void toggleMicMute()}
            aria-pressed={micMuted}
            aria-label={micMuted ? 'Unmute microphone' : 'Mute microphone'}
            className={`flex w-full items-center justify-center gap-2 rounded-[var(--r-md)] py-2 text-sm font-semibold ring-1 ring-inset transition hover:brightness-110 ${
              micMuted
                ? 'bg-error-soft text-error ring-error'
                : 'bg-[var(--surface-2)] text-[var(--fg)] ring-[var(--border)]'
            }`}
          >
            {micMuted ? <MicOff size={17} /> : <Mic size={17} />}
            {micMuted ? 'Unmute mic' : 'Mute mic'}
          </button>

          {/* Slide nav */}
          <div className="flex items-center gap-2">
            <button onClick={() => changeSlide(-1)} aria-label="Previous slide" className="btn-ghost flex items-center justify-center rounded-[var(--r-md)] px-4 py-2.5">
              <ChevronLeft size={18} />
            </button>
            <span className="flex-1 text-center text-sm font-medium text-[var(--muted)]">
              Slide {slideIndex + 1}
              {slideCount !== null ? <span className="text-[var(--faint)]"> / {slideCount}</span> : ''}
            </span>
            <button onClick={() => changeSlide(1)} aria-label="Next slide" className="btn-ghost flex items-center justify-center rounded-[var(--r-md)] px-4 py-2.5">
              <ChevronRight size={18} />
            </button>
          </div>
        </div>

        {/* 2) Tabs */}
        <div className="flex shrink-0 gap-4 border-b border-[var(--border)] px-4">
          {(['setup', 'polls', 'audience'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setConsoleTab(t)}
              className={`relative py-2 text-sm font-medium capitalize transition ${
                tab === t ? 'text-[var(--fg)]' : 'text-[var(--faint)] hover:text-[var(--muted)]'
              }`}
            >
              {t === 'audience' ? 'Analytics' : t}
              {tab === t && <span className="grad-rule absolute inset-x-0 bottom-0 h-0.5 rounded-full" />}
            </button>
          ))}
        </div>

        {/* 3) Tab body — the only scrolling region */}
        <div className="flex-1 overflow-y-auto p-4">
          {tab === 'setup' && (
            <div className="space-y-4">
        {/* Microphone + one guided routing choice (collapses once live since it
            is configured pre-talk; advanced options behind a disclosure). */}
        <details open={state !== 'live'} className="rounded-[var(--r-lg)] bg-[var(--surface-2)] p-3.5 ring-1 ring-inset ring-[var(--border)]">
          <summary className="cursor-pointer list-none text-xs font-semibold uppercase tracking-wide text-[var(--faint)]">
            Microphone &amp; audio
          </summary>

          <div className="mt-3 space-y-4">
            {/* Mic */}
            <div className="space-y-2.5">
              <label className="text-xs font-semibold uppercase tracking-wide text-[var(--faint)]">Microphone</label>
              <select
                value={micId}
                onChange={(e) => void switchMic(e.target.value)}
                className="input-field w-full px-3 py-2 text-sm text-[var(--fg)]"
              >
                {inputs.length === 0 && (
                  <option value="" className="bg-[var(--surface)]">No microphones found</option>
                )}
                {inputs.map((d) => (
                  <option key={d.deviceId} value={d.deviceId} className="bg-[var(--surface)]">
                    {d.label || `Mic ${d.deviceId.slice(0, 6)}`}
                  </option>
                ))}
              </select>
              <div className="h-2.5 overflow-hidden rounded-full bg-[var(--surface-3)] ring-1 ring-inset ring-[var(--border)]">
                <div
                  className="grad-fill h-full rounded-full transition-[width] duration-100"
                  style={{ width: `${Math.round(micLevel * 100)}%` }}
                />
              </div>
              {micError && <p className="text-xs text-error">{micError}</p>}
              {!micReady && !micError && <p className="text-xs text-[var(--faint)]">Requesting microphone…</p>}
            </div>

            {/* Routing — the single primary audio choice */}
            <fieldset className="space-y-2">
              <legend className="mb-1 text-xs font-semibold uppercase tracking-wide text-[var(--faint)]">
                Where does translated audio play?
              </legend>
              {([
                { value: 'room', Icon: Volume2, label: 'Room speakers', hint: 'Through this machine · echo auto-cancelled' },
                { value: 'headphones', Icon: Headphones, label: 'My headphones', hint: 'Monitor privately — no feedback risk' },
                { value: 'viewers', Icon: Smartphone, label: "Viewers' phones only", hint: 'Captions + slides here · audio per device' },
              ] as const).map(({ value, Icon, label, hint }) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => void applyRouting(value)}
                  aria-pressed={routing === value}
                  className={`flex w-full items-start gap-3 rounded-[var(--r-md)] p-3 text-left ring-1 ring-inset transition ${
                    routing === value
                      ? 'grad-border'
                      : 'bg-[var(--surface)] ring-[var(--border)] hover:ring-[var(--border-strong)]'
                  }`}
                >
                  <Icon size={18} className={`mt-0.5 shrink-0 ${routing === value ? 'text-[var(--cyan)]' : 'text-[var(--muted)]'}`} />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-[var(--fg)]">{label}</span>
                    <span className="block text-[11px] leading-snug text-[var(--faint)]">{hint}</span>
                  </span>
                </button>
              ))}
            </fieldset>

            {/* Advanced — output device, half-duplex, browser DSP, warnings */}
            <details
              open={advancedAudioOpen}
              onToggle={(e) => setAdvancedAudioOpen(e.currentTarget.open)}
              className="rounded-[var(--r-md)] bg-[var(--surface)] p-3 ring-1 ring-inset ring-[var(--border)]"
            >
              <summary className="cursor-pointer list-none text-xs text-[var(--faint)]">Advanced audio</summary>
              <div className="mt-3 space-y-3">
                <div className="space-y-2">
                  <label className="text-xs font-semibold uppercase tracking-wide text-[var(--faint)]">
                    Audio output (speaker / HDMI)
                  </label>
                  {supportsSinkId ? (
                    <select
                      value={speakerId}
                      onChange={(e) => {
                        setSpeakerId(e.target.value);
                        void monitorRef.current?.setSink(e.target.value).then((ok) => {
                          if (ok === false) setAudioError('Audio output error: this browser could not switch to that output.');
                          else setAudioError(null);
                        });
                      }}
                      className="input-field w-full px-3 py-2 text-sm text-[var(--fg)]"
                    >
                      <option value="" className="bg-[var(--surface)]">System default output</option>
                      {outputs.map((d) => (
                        <option key={d.deviceId} value={d.deviceId} className="bg-[var(--surface)]">
                          {d.label || `Output ${d.deviceId.slice(0, 6)}`}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <p className="text-xs text-[var(--faint)]">
                      This browser can't pick an output device — set the HDMI device as your system
                      default output instead.
                    </p>
                  )}
                </div>
                <label className="flex items-start gap-2 text-xs leading-relaxed text-[var(--muted)]">
                  <input
                    type="checkbox"
                    checked={halfDuplex}
                    onChange={(e) => setHalfDuplex(e.target.checked)}
                    className="mt-0.5 accent-[var(--cyan)]"
                  />
                  <span>
                    Mute mic while translation plays — echo/looping backstop for Room speakers. Only
                    needed if the mic hears the speakers; it clips continuous speech.
                  </span>
                </label>
                <label className="flex items-start gap-2 text-xs leading-relaxed text-[var(--faint)]">
                  <input
                    type="checkbox"
                    checked={roomMode || browserDsp}
                    disabled={roomMode}
                    onChange={(e) => setBrowserDsp(e.target.checked)}
                    className="mt-0.5 accent-[var(--cyan)]"
                  />
                  {roomMode
                    ? 'Echo cancellation on (managed by Room speakers)'
                    : 'Browser DSP (echo cancel / noise suppression) — off recommended; takes effect on mic re-select'}
                </label>
                {routing === 'room' && !speakerId && !halfDuplex && (
                  <p className="rounded-[var(--r-md)] bg-error-soft px-2.5 py-2 text-[11px] leading-relaxed text-error ring-1 ring-inset ring-error">
                    Output is your built-in speakers — with the mic nearby the audio can loop. Pick a
                    separate output (HDMI/PA) above, use a close-talk mic, or enable mute-while-playing.
                  </p>
                )}
                {routing === 'headphones' && (
                  <p className="rounded-[var(--r-md)] bg-warning-soft px-2.5 py-2 text-xs text-warning ring-1 ring-inset ring-warning">
                    Use actual headphones — monitoring through your mic machine's speakers risks a
                    feedback loop.
                  </p>
                )}
                {audioError && <p className="text-xs text-error">{audioError}</p>}
              </div>
            </details>
          </div>
        </details>

        {/* Share */}
        <div className="space-y-3">
          <label className="text-xs font-semibold uppercase tracking-wide text-[var(--faint)]">Audience link</label>
          <div className="flex justify-center">
            <QrCode url={viewerUrl} size={156} />
          </div>
          <div className="flex gap-2">
            <input readOnly value={viewerUrl} className="input-field min-w-0 flex-1 px-2.5 py-1.5 text-xs text-[var(--muted)]" />
            <button
              onClick={() => void navigator.clipboard.writeText(viewerUrl)}
              className="btn-ghost rounded-lg px-3 py-1.5 text-xs"
            >
              Copy
            </button>
          </div>
          <div className="flex gap-2">
            <a
              href={`/${slug}/present`}
              target="_blank"
              rel="noreferrer"
              className="btn-ghost flex flex-1 items-center justify-center gap-1.5 rounded-[var(--r-md)] px-3 py-2 text-center text-xs"
              title="Open the projector/stage view (slides + captions + QR) in a new tab"
            >
              <MonitorPlay size={15} /> Project (stage view)
            </a>
            {pip.supported && (
              <button
                onClick={() => (pip.isOpen ? pip.close() : void pip.open())}
                className="btn-ghost flex flex-1 items-center justify-center gap-1.5 rounded-[var(--r-md)] px-3 py-2 text-xs"
                title="Float captions over your other apps (Chrome/Edge)"
              >
                {pip.isOpen ? <X size={15} /> : <PictureInPicture2 size={15} />}
                {pip.isOpen ? 'Captions' : 'Pop out captions'}
              </button>
            )}
          </div>
        </div>

            </div>
          )}

          {tab === 'polls' && (
            <div className="space-y-3">
          <label className="text-xs font-semibold uppercase tracking-wide text-[var(--faint)]">
            Live poll / quiz
          </label>
          {poll.poll ? (
            <div className="space-y-2.5 rounded-2xl bg-[var(--surface-2)] p-3 ring-1 ring-inset ring-[var(--border)]">
              <PollResults poll={poll.poll} />
              {!poll.poll.closed ? (
                <button onClick={() => pollAction('poll.close')} className="btn-ghost w-full rounded-lg py-2 text-sm">
                  Close poll
                </button>
              ) : (
                <div className="grid grid-cols-2 gap-2">
                  <button
                    onClick={() => pollAction('poll.pin', !poll.poll!.pinned)}
                    className={`rounded-lg py-1.5 text-xs ring-1 ring-inset ${
                      poll.poll.pinned
                        ? 'grad-border text-[var(--fg)] ring-transparent'
                        : 'btn-ghost'
                    }`}
                  >
                    {poll.poll.pinned ? (
                      <span className="inline-flex items-center gap-1">
                        <Check size={12} /> Showing
                      </span>
                    ) : (
                      'Keep showing'
                    )}
                  </button>
                  <button onClick={() => pollAction('poll.hide')} className="btn-ghost rounded-[var(--r-md)] py-1.5 text-xs">
                    Hide
                  </button>
                  {confirmDeletePoll ? (
                    <button
                      onClick={() => pollAction('poll.delete')}
                      className="col-span-2 rounded-[var(--r-md)] bg-error-soft py-1.5 text-xs font-medium text-error ring-1 ring-inset ring-error"
                    >
                      Confirm delete
                    </button>
                  ) : (
                    <button
                      onClick={() => setConfirmDeletePoll(true)}
                      className="col-span-2 rounded-[var(--r-md)] py-1.5 text-xs text-error ring-1 ring-inset ring-error transition hover:bg-error-soft"
                    >
                      Delete poll…
                    </button>
                  )}
                </div>
              )}
              {!poll.poll.closed && (
                <p className="text-[11px] text-[var(--faint)]">
                  After closing, it auto-hides for viewers in 10s unless you keep it showing.
                </p>
              )}
            </div>
          ) : (
            <div className="space-y-2">
              <input
                value={pollQuestion}
                onChange={(e) => setPollQuestion(e.target.value)}
                placeholder="Poll / quiz question"
                className="input-field w-full px-3 py-2 text-sm text-[var(--fg)] placeholder:text-[var(--faint)]"
              />
              {pollOptions.map((opt, i) => (
                <div key={i} className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => setPollCorrect((c) => c.map((v, j) => (j === i ? !v : v)))}
                    title="Mark as correct answer (quiz)"
                    aria-label={pollCorrect[i] ? 'Unmark correct answer' : 'Mark as correct answer'}
                    aria-pressed={pollCorrect[i]}
                    className={`flex shrink-0 items-center justify-center rounded-[var(--r-md)] px-2 py-2 ring-1 ring-inset transition ${
                      pollCorrect[i]
                        ? 'grad-fill'
                        : 'text-[var(--faint)] ring-[var(--border)] hover:text-[var(--muted)]'
                    }`}
                  >
                    <Check size={16} />
                  </button>
                  <input
                    value={opt}
                    onChange={(e) => setPollOptions((o) => o.map((v, j) => (j === i ? e.target.value : v)))}
                    placeholder={`Option ${i + 1}`}
                    className="input-field min-w-0 flex-1 px-3 py-2 text-sm text-[var(--fg)] placeholder:text-[var(--faint)]"
                  />
                  {pollOptions.length > 2 && (
                    <button
                      type="button"
                      onClick={() => removeOption(i)}
                      aria-label="Remove option"
                      className="flex shrink-0 items-center justify-center rounded-[var(--r-md)] px-2 py-2 text-[var(--faint)] ring-1 ring-inset ring-[var(--border)] hover:text-error"
                    >
                      <X size={16} />
                    </button>
                  )}
                </div>
              ))}
              <p className="text-[11px] text-[var(--faint)]">Tap the check to mark correct answer(s) — makes it a quiz (revealed on close).</p>
              <div className="flex gap-2">
                {pollOptions.length < 6 && (
                  <button onClick={addOption} className="btn-ghost flex items-center gap-1 rounded-[var(--r-md)] px-3 py-1.5 text-xs">
                    <Plus size={14} /> Option
                  </button>
                )}
                <button
                  onClick={launchPoll}
                  disabled={!pollQuestion.trim() || pollOptions.filter((o) => o.trim()).length < 2}
                  className="btn-primary flex flex-1 items-center justify-center gap-1.5 rounded-[var(--r-md)] py-1.5 text-sm disabled:opacity-50"
                >
                  <Play size={14} /> Launch
                </button>
              </div>
            </div>
          )}
        </div>

          )}

          {tab === 'audience' && (
            <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <label className="text-xs font-semibold uppercase tracking-wide text-[var(--faint)]">
                Attendance
              </label>
              {analyticsUpdatedAt && (
                <p className="mt-0.5 text-[11px] text-[var(--faint)]">Updated {fmtTime(analyticsUpdatedAt)}</p>
              )}
            </div>
            <button
              onClick={() => void refreshAnalytics()}
              disabled={analyticsRefreshing}
              className="text-[var(--faint)] transition hover:text-[var(--fg)]"
              aria-label={analyticsRefreshing ? 'Refreshing attendance' : 'Refresh attendance'}
              title="Refresh attendance"
            >
              <RotateCw size={14} className={analyticsRefreshing ? 'animate-spin' : undefined} />
            </button>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Stat label="Live now" value={viewerCount} />
            <Stat label="Joined" value={analytics?.uniqueAttendees ?? 0} />
            <Stat label="Peak" value={analytics?.peakConcurrent ?? 0} />
            <Stat label="Avg watch" value={fmtDur(analytics?.avgWatchMs ?? 0)} />
          </div>
          {analytics && analytics.attendees.length > 0 && (
            <div className="max-h-52 space-y-0.5 overflow-y-auto rounded-xl bg-[var(--surface-2)] p-1.5 ring-1 ring-inset ring-[var(--border)]">
              {analytics.attendees.map((a, i) => (
                <div
                  key={i}
                  className="flex items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-xs hover:bg-[var(--surface-2)]"
                >
                  <div className="min-w-0">
                    <div className="truncate text-[var(--fg)]">{a.name || 'Anonymous'}</div>
                    {a.company && <div className="truncate text-[var(--faint)]">{a.company}</div>}
                  </div>
                  <span className="shrink-0 font-mono text-[var(--muted)]">{fmtDur(a.watchedMs)}</span>
                </div>
              ))}
            </div>
          )}
          {analytics && (
            <p className="flex items-center gap-1.5 text-[11px] text-[var(--faint)]">
              <Users size={13} /> {analytics.namedCount} shared name/company
            </p>
          )}
          {analytics?.attendeeListTruncated && (
            <p className="text-[11px] text-[var(--faint)]">
              Showing first {analytics.attendeeLimit} attendees by watch time.
            </p>
          )}
          {analytics && Object.keys(analytics.reactions ?? {}).length > 0 && (
            <p className="text-xs text-[var(--muted)]">
              {Object.entries(analytics.reactions).map(([e, n]) => `${e} ${n}`).join('   ')}
            </p>
          )}
            </div>
          )}
        </div>

        {/* Pinned footer */}
        <div className="shrink-0 border-t border-[var(--border)] p-3">
          {import.meta.env.DEV && state === 'live' && (
            <button
              onClick={() => sendControl('kill_gemini_test')}
              className="mb-2 w-full rounded-[var(--r-md)] border border-dashed border-[var(--border)] py-1.5 text-xs text-[var(--faint)] transition hover:text-[var(--muted)]"
            >
              [test] kill Gemini WS
            </button>
          )}
        </div>
      </aside>

      {pip.container &&
        createPortal(
          <CaptionOverlay
            lines={output.lines}
            label={session.targetLang}
            className="h-screen bg-[var(--bg)] p-5"
          />,
          pip.container
        )}

    </div>
  );
}
