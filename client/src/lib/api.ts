export interface SessionInfo {
  slug: string;
  title: string;
  targetLang: string;
  slideType: 'pdf' | 'gslides' | 'html';
  slideUrl: string;
  slideCount: number | null;
  state: 'created' | 'live' | 'paused' | 'ended' | 'reconnecting';
  slideIndex: number;
  startedAt: string | null;
  endedAt: string | null;
  presentationMode: 'in_person' | 'remote';
  audienceEnabled: boolean;
  audio: {
    transport: 'sfu' | 'none';
    available: boolean;
    reason?:
      | 'audience_disabled'
      | 'subscription_inactive'
      | 'not_configured'
      | 'not_started'
      | 'publish_failed';
  };
}

export interface TranscriptSegment {
  kind: 'input' | 'output';
  languageCode: string;
  text: string;
  tOffsetMs: number;
  slideIndex: number;
}

export interface TranscriptData {
  title: string;
  targetLang: string;
  state: string;
  startedAt: string | null;
  endedAt: string | null;
  segments: TranscriptSegment[];
}

export interface Language {
  code: string;
  name: string;
}

/** Live poll state broadcast over WS (poll.state) and in the join snapshot. */
export interface LivePoll {
  id: string;
  question: string;
  options: string[];
  counts: number[];
  total: number;
  closed: boolean;
  pinned: boolean;
  correctOptions?: number[]; // revealed only once closed (quiz)
}

/** Final poll results from GET /api/sessions/:slug/polls (transcript page). */
export interface PollResult {
  pollId: string;
  question: string;
  options: string[];
  counts: number[];
  total: number;
  endedAt: string | null;
  correctOptions: number[];
}

function bearerHeaders(auth?: string): HeadersInit | undefined {
  return auth ? { Authorization: `Bearer ${auth}` } : undefined;
}

export async function fetchPolls(slug: string, auth?: string): Promise<PollResult[]> {
  const res = await fetch(`/api/sessions/${slug}/polls`, { headers: bearerHeaders(auth) });
  if (!res.ok) return [];
  const body = await res.json();
  return body.polls ?? [];
}

export const REACTION_EMOJIS = ['👍', '❤️', '🎉', '👏', '😮', '😂'] as const;

export async function fetchSession(slug: string, auth?: string): Promise<SessionInfo> {
  const res = await fetch(`/api/sessions/${slug}`, { headers: bearerHeaders(auth) });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    const error = new Error(body.error ?? `HTTP ${res.status}`) as Error & {
      code?: string;
      status?: number;
    };
    error.code = body.code;
    error.status = res.status;
    throw error;
  }
  return res.json();
}

export async function fetchTranscript(slug: string, auth?: string): Promise<TranscriptData> {
  const res = await fetch(`/api/sessions/${slug}/transcript`, { headers: bearerHeaders(auth) });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `transcript not found (${res.status})` }));
    const error = new Error(body.error ?? `transcript not found (${res.status})`) as Error & {
      code?: string;
      status?: number;
    };
    error.code = body.code;
    error.status = res.status;
    throw error;
  }
  return res.json();
}

export async function fetchLanguages(): Promise<Language[]> {
  const res = await fetch('/api/languages');
  return res.json();
}

export interface Analytics {
  state: string;
  live: number;
  uniqueAttendees: number;
  peakConcurrent: number;
  totalWatchMs: number;
  avgWatchMs: number;
  namedCount: number;
  attendeeListTruncated: boolean;
  attendeeLimit: number;
  reactions: Record<string, number>;
  attendees: {
    name: string;
    company: string;
    joins: number;
    watchedMs: number;
    firstJoinedAt: string;
    lastSeenAt: string;
  }[];
}

export interface SessionListItem {
  slug: string;
  title: string;
  targetLang: string;
  slideType: 'pdf' | 'gslides' | 'html';
  echoTargetLanguage: boolean;
  state: string;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  peakViewers: number;
  attendeeCount: number;
  liveViewers: number;
  presentationMode: 'in_person' | 'remote';
  audienceEnabled: boolean;
}

export async function listSessions(adminKey: string): Promise<SessionListItem[]> {
  const res = await fetch('/api/sessions', {
    headers: { Authorization: `Bearer ${adminKey}` },
  });
  if (!res.ok) throw new Error(`list HTTP ${res.status}`);
  return res.json();
}

export async function updateSession(
  adminKey: string,
  slug: string,
  patch: { title?: string; targetLang?: string; echoTargetLanguage?: boolean }
): Promise<void> {
  const res = await fetch(`/api/sessions/${slug}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${adminKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`update HTTP ${res.status}`);
}

export async function deleteSession(adminKey: string, slug: string): Promise<void> {
  const res = await fetch(`/api/sessions/${slug}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${adminKey}` },
  });
  if (!res.ok) throw new Error(`delete HTTP ${res.status}`);
}

export async function fetchAnalytics(adminKey: string, slug: string): Promise<Analytics> {
  const res = await fetch(`/api/sessions/${slug}/analytics`, {
    headers: { Authorization: `Bearer ${adminKey}` },
  });
  if (!res.ok) throw new Error(`analytics HTTP ${res.status}`);
  return res.json();
}

export async function subscribeAudio(
  slug: string,
  sessionDescription: RTCSessionDescriptionInit,
  opts: { recoverPublisher?: boolean; publisherGeneration?: number; reason?: string } = {}
): Promise<{ sessionDescription: RTCSessionDescriptionInit; publisherGeneration: number }> {
  const res = await fetch(`/api/sessions/${slug}/audio/subscribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionDescription, ...opts }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json();
}

export async function createSession(
  adminKey: string,
  form: FormData
): Promise<{ slug: string; viewerPath: string; hostPath: string; audienceEnabled: boolean }> {
  const res = await fetch('/api/sessions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminKey}` },
    body: form,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json();
}
