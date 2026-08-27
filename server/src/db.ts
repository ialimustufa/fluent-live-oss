import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

export interface SessionRow {
  id: number;
  slug: string;
  title: string;
  target_lang: string;
  slide_type: 'pdf' | 'gslides' | 'html';
  slide_ref: string;
  slide_count: number | null;
  echo_target_language: number;
  state: 'created' | 'live' | 'paused' | 'ended';
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
  peak_viewers: number;
  is_trial: number;
  trial_type: 'none' | 'try' | 'beta';
  presentation_mode: 'in_person' | 'remote';
}

export interface BetaLeadRow {
  id: number;
  normalized_email: string;
  email: string;
  full_name: string;
  company: string;
  budget: string;
  session_slug: string;
  duplicate_attempts: number;
  expedite_requested: number;
  expedite_requested_at: string | null;
  feedback_rating: number | null;
  feedback_text: string;
  feedback_submitted_at: string | null;
  first_trial_at: string;
  last_duplicate_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface TrialAbuseEventRow {
  id: number;
  flow: 'try' | 'beta';
  allowed: number;
  reason: string;
  ip_hash: string;
  email: string;
  normalized_email: string;
  key_hash_prefix: string;
  session_slug: string | null;
  status_code: number | null;
  detail: string;
  created_at: string;
}

export interface AttendeeRow {
  id: number;
  session_id: number;
  viewer_id: string;
  name: string;
  company: string;
  joins: number;
  total_ms: number;
  first_joined_at: string;
  last_seen_at: string;
}

export interface TranscriptRow {
  id: number;
  session_id: number;
  kind: 'input' | 'output';
  language_code: string;
  text: string;
  is_final: number;
  t_offset_ms: number;
  slide_index: number;
  created_at: string;
}

let db: Database.Database;

export function initDb(databasePath: string): Database.Database {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  db = new Database(databasePath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL DEFAULT '',
      target_lang TEXT NOT NULL,
      slide_type TEXT NOT NULL CHECK (slide_type IN ('pdf','gslides','html')),
      slide_ref TEXT NOT NULL,
      slide_count INTEGER,
      echo_target_language INTEGER NOT NULL DEFAULT 0,
      state TEXT NOT NULL DEFAULT 'created' CHECK (state IN ('created','live','paused','ended')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      started_at TEXT,
      ended_at TEXT,
      presentation_mode TEXT NOT NULL DEFAULT 'in_person' CHECK (presentation_mode IN ('in_person','remote'))
    );

    CREATE TABLE IF NOT EXISTS transcripts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL REFERENCES sessions(id),
      kind TEXT NOT NULL CHECK (kind IN ('input','output')),
      language_code TEXT NOT NULL,
      text TEXT NOT NULL,
      is_final INTEGER NOT NULL DEFAULT 1,
      t_offset_ms INTEGER NOT NULL,
      slide_index INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_transcripts_session
      ON transcripts(session_id, t_offset_ms);

    CREATE TABLE IF NOT EXISTS attendees (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL REFERENCES sessions(id),
      viewer_id TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      company TEXT NOT NULL DEFAULT '',
      joins INTEGER NOT NULL DEFAULT 0,
      total_ms INTEGER NOT NULL DEFAULT 0,
      first_joined_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(session_id, viewer_id)
    );

    CREATE TABLE IF NOT EXISTS polls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL REFERENCES sessions(id),
      poll_id TEXT NOT NULL,
      question TEXT NOT NULL,
      options TEXT NOT NULL,
      correct TEXT NOT NULL DEFAULT '[]',
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      ended_at TEXT,
      UNIQUE(session_id, poll_id)
    );

    CREATE TABLE IF NOT EXISTS poll_votes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL REFERENCES sessions(id),
      poll_id TEXT NOT NULL,
      viewer_id TEXT NOT NULL,
      option_index INTEGER NOT NULL,
      voted_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(session_id, poll_id, viewer_id)
    );

    CREATE TABLE IF NOT EXISTS reaction_tallies (
      session_id INTEGER NOT NULL REFERENCES sessions(id),
      emoji TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      UNIQUE(session_id, emoji)
    );

    CREATE TABLE IF NOT EXISTS beta_leads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      normalized_email TEXT NOT NULL UNIQUE,
      email TEXT NOT NULL,
      full_name TEXT NOT NULL,
      company TEXT NOT NULL,
      budget TEXT NOT NULL,
      session_slug TEXT NOT NULL UNIQUE,
      duplicate_attempts INTEGER NOT NULL DEFAULT 0,
      expedite_requested INTEGER NOT NULL DEFAULT 0,
      expedite_requested_at TEXT,
      feedback_rating INTEGER,
      feedback_text TEXT NOT NULL DEFAULT '',
      feedback_submitted_at TEXT,
      first_trial_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_duplicate_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS trial_rate_limits (
      scope TEXT NOT NULL,
      key_hash TEXT NOT NULL,
      window_start_ms INTEGER NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (scope, key_hash, window_start_ms)
    );

    CREATE INDEX IF NOT EXISTS idx_trial_rate_limits_updated
      ON trial_rate_limits(updated_at);

    CREATE TABLE IF NOT EXISTS trial_abuse_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      flow TEXT NOT NULL CHECK (flow IN ('try','beta')),
      allowed INTEGER NOT NULL DEFAULT 0,
      reason TEXT NOT NULL,
      ip_hash TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL DEFAULT '',
      normalized_email TEXT NOT NULL DEFAULT '',
      key_hash_prefix TEXT NOT NULL DEFAULT '',
      session_slug TEXT,
      status_code INTEGER,
      detail TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_trial_abuse_events_created
      ON trial_abuse_events(created_at);

    CREATE INDEX IF NOT EXISTS idx_trial_abuse_events_ip
      ON trial_abuse_events(ip_hash, created_at);

    CREATE INDEX IF NOT EXISTS idx_trial_abuse_events_email
      ON trial_abuse_events(normalized_email, created_at);
  `);

  // Migrations: add columns to pre-existing sessions tables.
  const cols = db.prepare(`PRAGMA table_info(sessions)`).all() as { name: string }[];
  if (!cols.some((c) => c.name === 'peak_viewers')) {
    db.exec(`ALTER TABLE sessions ADD COLUMN peak_viewers INTEGER NOT NULL DEFAULT 0`);
  }
  if (!cols.some((c) => c.name === 'is_trial')) {
    db.exec(`ALTER TABLE sessions ADD COLUMN is_trial INTEGER NOT NULL DEFAULT 0`);
  }
  if (!cols.some((c) => c.name === 'trial_type')) {
    db.exec(`ALTER TABLE sessions ADD COLUMN trial_type TEXT NOT NULL DEFAULT 'none'`);
    db.exec(`UPDATE sessions SET trial_type = CASE WHEN is_trial = 1 THEN 'try' ELSE 'none' END`);
  }
  if (!cols.some((c) => c.name === 'presentation_mode')) {
    db.exec(`ALTER TABLE sessions ADD COLUMN presentation_mode TEXT NOT NULL DEFAULT 'in_person'`);
  }
  // polls.correct added after polls shipped without it.
  const pollCols = db.prepare(`PRAGMA table_info(polls)`).all() as { name: string }[];
  if (pollCols.length && !pollCols.some((c) => c.name === 'correct')) {
    db.exec(`ALTER TABLE polls ADD COLUMN correct TEXT NOT NULL DEFAULT '[]'`);
  }
  const betaLeadCols = db.prepare(`PRAGMA table_info(beta_leads)`).all() as { name: string }[];
  if (betaLeadCols.length && !betaLeadCols.some((c) => c.name === 'expedite_requested')) {
    db.exec(`ALTER TABLE beta_leads ADD COLUMN expedite_requested INTEGER NOT NULL DEFAULT 0`);
  }
  if (betaLeadCols.length && !betaLeadCols.some((c) => c.name === 'expedite_requested_at')) {
    db.exec(`ALTER TABLE beta_leads ADD COLUMN expedite_requested_at TEXT`);
  }
  if (betaLeadCols.length && !betaLeadCols.some((c) => c.name === 'feedback_rating')) {
    db.exec(`ALTER TABLE beta_leads ADD COLUMN feedback_rating INTEGER`);
  }
  if (betaLeadCols.length && !betaLeadCols.some((c) => c.name === 'feedback_text')) {
    db.exec(`ALTER TABLE beta_leads ADD COLUMN feedback_text TEXT NOT NULL DEFAULT ''`);
  }
  if (betaLeadCols.length && !betaLeadCols.some((c) => c.name === 'feedback_submitted_at')) {
    db.exec(`ALTER TABLE beta_leads ADD COLUMN feedback_submitted_at TEXT`);
  }

  return db;
}

export function getDb(): Database.Database {
  if (!db) throw new Error('DB not initialized');
  return db;
}

// --- Session queries ---

export function createSession(row: {
  slug: string;
  title: string;
  target_lang: string;
  slide_type: string;
  slide_ref: string;
  slide_count: number | null;
  echo_target_language: boolean;
  is_trial?: boolean;
  trial_type?: 'none' | 'try' | 'beta';
  presentation_mode?: 'in_person' | 'remote';
}): SessionRow {
  getDb()
    .prepare(
      `INSERT INTO sessions (slug, title, target_lang, slide_type, slide_ref, slide_count, echo_target_language, is_trial, trial_type, presentation_mode)
       VALUES (@slug, @title, @target_lang, @slide_type, @slide_ref, @slide_count, @echo, @is_trial, @trial_type, @presentation_mode)`
    )
    .run({
      ...row,
      echo: row.echo_target_language ? 1 : 0,
      is_trial: row.is_trial ? 1 : 0,
      trial_type: row.trial_type ?? (row.is_trial ? 'try' : 'none'),
      presentation_mode: row.presentation_mode ?? 'in_person',
    });
  return getSessionBySlug(row.slug)!;
}

export function createBetaTrialSession(row: {
  session: {
    slug: string;
    title: string;
    target_lang: string;
    slide_type: string;
    slide_ref: string;
    slide_count: number | null;
    echo_target_language: boolean;
    presentation_mode?: 'in_person' | 'remote';
  };
  lead: {
    normalized_email: string;
    email: string;
    full_name: string;
    company: string;
    budget: string;
  };
}): SessionRow {
  const db = getDb();
  db.transaction(() => {
    db.prepare(
      `INSERT INTO sessions (slug, title, target_lang, slide_type, slide_ref, slide_count, echo_target_language, is_trial, trial_type, presentation_mode)
       VALUES (@slug, @title, @target_lang, @slide_type, @slide_ref, @slide_count, @echo, 1, 'beta', @presentation_mode)`
    ).run({
      ...row.session,
      echo: row.session.echo_target_language ? 1 : 0,
      presentation_mode: row.session.presentation_mode ?? 'in_person',
    });
    db.prepare(
      `INSERT INTO beta_leads (normalized_email, email, full_name, company, budget, session_slug)
       VALUES (@normalized_email, @email, @full_name, @company, @budget, @session_slug)`
    ).run({
      ...row.lead,
      session_slug: row.session.slug,
    });
  })();
  return getSessionBySlug(row.session.slug)!;
}

export function getSessionBySlug(slug: string): SessionRow | undefined {
  return getDb().prepare('SELECT * FROM sessions WHERE slug = ?').get(slug) as
    | SessionRow
    | undefined;
}

export function updateSessionState(
  id: number,
  state: SessionRow['state'],
  opts: { markStarted?: boolean; markEnded?: boolean; clearEnded?: boolean } = {}
): void {
  const sets = ['state = @state'];
  if (opts.markStarted) sets.push(`started_at = COALESCE(started_at, datetime('now'))`);
  if (opts.markEnded) sets.push(`ended_at = datetime('now')`);
  // Resuming an ended session: it's live again, so drop the end timestamp.
  if (opts.clearEnded) sets.push(`ended_at = NULL`);
  getDb()
    .prepare(`UPDATE sessions SET ${sets.join(', ')} WHERE id = @id`)
    .run({ id, state });
}

// --- Transcript queries ---

export function insertTranscript(row: {
  session_id: number;
  kind: 'input' | 'output';
  language_code: string;
  text: string;
  t_offset_ms: number;
  slide_index: number;
}): void {
  getDb()
    .prepare(
      `INSERT INTO transcripts (session_id, kind, language_code, text, is_final, t_offset_ms, slide_index)
       VALUES (@session_id, @kind, @language_code, @text, 1, @t_offset_ms, @slide_index)`
    )
    .run(row);
}

export function getTranscripts(sessionId: number): TranscriptRow[] {
  return getDb()
    .prepare(
      'SELECT * FROM transcripts WHERE session_id = ? ORDER BY t_offset_ms ASC, id ASC'
    )
    .all(sessionId) as TranscriptRow[];
}

// --- Attendance / analytics queries ---

/** Upsert on (re)join: bumps the join count and refreshes name/company
 *  (only overwriting with non-empty values so a later blank doesn't wipe them). */
export function recordAttendeeJoin(row: {
  session_id: number;
  viewer_id: string;
  name: string;
  company: string;
}): void {
  getDb()
    .prepare(
      `INSERT INTO attendees (session_id, viewer_id, name, company, joins)
       VALUES (@session_id, @viewer_id, @name, @company, 1)
       ON CONFLICT(session_id, viewer_id) DO UPDATE SET
         joins = joins + 1,
         name = CASE WHEN @name != '' THEN @name ELSE name END,
         company = CASE WHEN @company != '' THEN @company ELSE company END,
         last_seen_at = datetime('now')`
    )
    .run(row);
}

/** Accumulate watched time for a viewer when a connection ends (or on flush). */
export function addAttendeeWatch(sessionId: number, viewerId: string, ms: number): void {
  if (ms <= 0) return;
  getDb()
    .prepare(
      `UPDATE attendees SET total_ms = total_ms + @ms, last_seen_at = datetime('now')
       WHERE session_id = @session_id AND viewer_id = @viewer_id`
    )
    .run({ session_id: sessionId, viewer_id: viewerId, ms: Math.round(ms) });
}

export function setPeakViewers(sessionId: number, n: number): void {
  getDb()
    .prepare(`UPDATE sessions SET peak_viewers = MAX(peak_viewers, @n) WHERE id = @id`)
    .run({ id: sessionId, n });
}

export function getAttendees(sessionId: number): AttendeeRow[] {
  return getDb()
    .prepare('SELECT * FROM attendees WHERE session_id = ? ORDER BY total_ms DESC, first_joined_at ASC')
    .all(sessionId) as AttendeeRow[];
}

// --- Admin session management ---

export function getAllSessions(): (SessionRow & { attendee_count: number })[] {
  return getDb()
    .prepare(
      `SELECT s.*, (SELECT COUNT(*) FROM attendees a WHERE a.session_id = s.id) AS attendee_count
       FROM sessions s WHERE s.is_trial = 0 ORDER BY datetime(s.created_at) DESC, s.id DESC`
    )
    .all() as (SessionRow & { attendee_count: number })[];
}

export function getTrialSessions(): SessionRow[] {
  return getDb()
    .prepare('SELECT * FROM sessions WHERE is_trial = 1 ORDER BY datetime(created_at) ASC, id ASC')
    .all() as SessionRow[];
}

export function getBetaLeadByNormalizedEmail(normalizedEmail: string): BetaLeadRow | undefined {
  return getDb()
    .prepare('SELECT * FROM beta_leads WHERE normalized_email = ?')
    .get(normalizedEmail) as BetaLeadRow | undefined;
}

export function getBetaLeadBySessionSlug(slug: string): BetaLeadRow | undefined {
  return getDb()
    .prepare('SELECT * FROM beta_leads WHERE session_slug = ?')
    .get(slug) as BetaLeadRow | undefined;
}

export function recordBetaLeadDuplicate(normalizedEmail: string): void {
  getDb()
    .prepare(
      `UPDATE beta_leads
       SET duplicate_attempts = duplicate_attempts + 1,
           last_duplicate_at = datetime('now'),
           updated_at = datetime('now')
       WHERE normalized_email = ?`
    )
    .run(normalizedEmail);
}

export function getBetaLeads(): BetaLeadRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM beta_leads
       ORDER BY datetime(first_trial_at) DESC, id DESC`
    )
    .all() as BetaLeadRow[];
}

export function consumeTrialRateLimit(row: {
  scope: string;
  key_hash: string;
  window_ms: number;
  max: number;
}): { allowed: boolean; count: number; resetAtMs: number } {
  const now = Date.now();
  const windowStartMs = Math.floor(now / row.window_ms) * row.window_ms;
  const resetAtMs = windowStartMs + row.window_ms;
  const db = getDb();

  const result = db.transaction(() => {
    db.prepare(
      `DELETE FROM trial_rate_limits
       WHERE updated_at < datetime('now', '-2 days')`
    ).run();
    const existing = db
      .prepare(
        `SELECT count FROM trial_rate_limits
         WHERE scope = @scope AND key_hash = @key_hash AND window_start_ms = @window_start_ms`
      )
      .get({
        scope: row.scope,
        key_hash: row.key_hash,
        window_start_ms: windowStartMs,
      }) as { count: number } | undefined;

    if (!existing) {
      db.prepare(
        `INSERT INTO trial_rate_limits (scope, key_hash, window_start_ms, count)
         VALUES (@scope, @key_hash, @window_start_ms, 1)`
      ).run({
        scope: row.scope,
        key_hash: row.key_hash,
        window_start_ms: windowStartMs,
      });
      return { allowed: true, count: 1, resetAtMs };
    }

    if (existing.count >= row.max) {
      return { allowed: false, count: existing.count, resetAtMs };
    }

    const nextCount = existing.count + 1;
    db.prepare(
      `UPDATE trial_rate_limits
       SET count = @count, updated_at = datetime('now')
       WHERE scope = @scope AND key_hash = @key_hash AND window_start_ms = @window_start_ms`
    ).run({
      scope: row.scope,
      key_hash: row.key_hash,
      window_start_ms: windowStartMs,
      count: nextCount,
    });
    return { allowed: true, count: nextCount, resetAtMs };
  })();

  return result;
}

export function recordTrialAbuseEvent(row: {
  flow: 'try' | 'beta';
  allowed: boolean;
  reason: string;
  ip_hash: string;
  email?: string;
  normalized_email?: string;
  key_hash_prefix?: string;
  session_slug?: string | null;
  status_code?: number | null;
  detail?: string;
}): void {
  getDb()
    .prepare(
      `INSERT INTO trial_abuse_events (
         flow, allowed, reason, ip_hash, email, normalized_email,
         key_hash_prefix, session_slug, status_code, detail
       )
       VALUES (
         @flow, @allowed, @reason, @ip_hash, @email, @normalized_email,
         @key_hash_prefix, @session_slug, @status_code, @detail
       )`
    )
    .run({
      flow: row.flow,
      allowed: row.allowed ? 1 : 0,
      reason: row.reason.slice(0, 80),
      ip_hash: row.ip_hash,
      email: (row.email ?? '').slice(0, 254),
      normalized_email: (row.normalized_email ?? '').slice(0, 254),
      key_hash_prefix: (row.key_hash_prefix ?? '').slice(0, 24),
      session_slug: row.session_slug ?? null,
      status_code: row.status_code ?? null,
      detail: (row.detail ?? '').slice(0, 500),
    });
}

export function getTrialAbuseEvents(limit = 100): TrialAbuseEventRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM trial_abuse_events
       ORDER BY datetime(created_at) DESC, id DESC
       LIMIT ?`
    )
    .all(Math.max(1, Math.min(500, Math.floor(limit)))) as TrialAbuseEventRow[];
}

export function recordBetaLeadExpedite(sessionSlug: string): BetaLeadRow | undefined {
  getDb()
    .prepare(
      `UPDATE beta_leads
       SET expedite_requested = 1,
           expedite_requested_at = COALESCE(expedite_requested_at, datetime('now')),
           updated_at = datetime('now')
       WHERE session_slug = ?`
    )
    .run(sessionSlug);
  return getBetaLeadBySessionSlug(sessionSlug);
}

export function recordBetaLeadFeedback(row: {
  session_slug: string;
  rating: number;
  feedback_text: string;
}): BetaLeadRow | undefined {
  getDb()
    .prepare(
      `UPDATE beta_leads
       SET feedback_rating = @rating,
           feedback_text = @feedback_text,
           feedback_submitted_at = datetime('now'),
           updated_at = datetime('now')
       WHERE session_slug = @session_slug`
    )
    .run(row);
  return getBetaLeadBySessionSlug(row.session_slug);
}

export function updateSessionMeta(
  slug: string,
  fields: { title?: string; target_lang?: string; echo_target_language?: boolean }
): SessionRow | undefined {
  const sets: string[] = [];
  const params: Record<string, unknown> = { slug };
  if (fields.title !== undefined) {
    sets.push('title = @title');
    params.title = fields.title.slice(0, 200);
  }
  if (fields.target_lang !== undefined) {
    sets.push('target_lang = @target_lang');
    params.target_lang = fields.target_lang;
  }
  if (fields.echo_target_language !== undefined) {
    sets.push('echo_target_language = @echo');
    params.echo = fields.echo_target_language ? 1 : 0;
  }
  if (sets.length) {
    getDb().prepare(`UPDATE sessions SET ${sets.join(', ')} WHERE slug = @slug`).run(params);
  }
  return getSessionBySlug(slug);
}

/** Delete a session and all its child rows. Returns the slide ref so the
 *  caller can clean up any uploaded file. */
export function deleteSession(slug: string): { slide_ref: string; slide_type: string } | null {
  const s = getSessionBySlug(slug);
  if (!s) return null;
  const db = getDb();
  db.transaction(() => {
    db.prepare('DELETE FROM transcripts WHERE session_id = ?').run(s.id);
    db.prepare('DELETE FROM attendees WHERE session_id = ?').run(s.id);
    db.prepare('DELETE FROM poll_votes WHERE session_id = ?').run(s.id);
    db.prepare('DELETE FROM polls WHERE session_id = ?').run(s.id);
    db.prepare('DELETE FROM reaction_tallies WHERE session_id = ?').run(s.id);
    db.prepare('DELETE FROM sessions WHERE id = ?').run(s.id);
  })();
  return { slide_ref: s.slide_ref, slide_type: s.slide_type };
}

// --- Interactive layer: polls + reactions ---

export function insertPoll(row: {
  session_id: number;
  poll_id: string;
  question: string;
  options: string[];
  correctOptions: number[];
}): void {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO polls (session_id, poll_id, question, options, correct)
       VALUES (@session_id, @poll_id, @question, @options, @correct)`
    )
    .run({
      session_id: row.session_id,
      poll_id: row.poll_id,
      question: row.question,
      options: JSON.stringify(row.options),
      correct: JSON.stringify(row.correctOptions),
    });
}

export function closePollRow(sessionId: number, pollId: string): void {
  getDb()
    .prepare(`UPDATE polls SET ended_at = datetime('now') WHERE session_id = ? AND poll_id = ?`)
    .run(sessionId, pollId);
}

export function deletePollById(sessionId: number, pollId: string): void {
  const db = getDb();
  db.transaction(() => {
    db.prepare('DELETE FROM poll_votes WHERE session_id = ? AND poll_id = ?').run(sessionId, pollId);
    db.prepare('DELETE FROM polls WHERE session_id = ? AND poll_id = ?').run(sessionId, pollId);
  })();
}

/** One vote per (session, poll, viewer); re-voting updates the choice. */
export function recordPollVote(row: {
  session_id: number;
  poll_id: string;
  viewer_id: string;
  option_index: number;
}): void {
  getDb()
    .prepare(
      `INSERT INTO poll_votes (session_id, poll_id, viewer_id, option_index)
       VALUES (@session_id, @poll_id, @viewer_id, @option_index)
       ON CONFLICT(session_id, poll_id, viewer_id) DO UPDATE SET
         option_index = @option_index, voted_at = datetime('now')`
    )
    .run(row);
}

export interface PollResult {
  pollId: string;
  question: string;
  options: string[];
  counts: number[];
  total: number;
  endedAt: string | null;
  correctOptions: number[];
}

export function getPollResults(sessionId: number): PollResult[] {
  const db = getDb();
  const polls = db
    .prepare('SELECT poll_id, question, options, correct, ended_at FROM polls WHERE session_id = ? ORDER BY started_at ASC')
    .all(sessionId) as {
    poll_id: string;
    question: string;
    options: string;
    correct: string;
    ended_at: string | null;
  }[];
  return polls.map((p) => {
    const options = JSON.parse(p.options) as string[];
    const counts = new Array(options.length).fill(0);
    const rows = db
      .prepare('SELECT option_index, COUNT(*) AS n FROM poll_votes WHERE session_id = ? AND poll_id = ? GROUP BY option_index')
      .all(sessionId, p.poll_id) as { option_index: number; n: number }[];
    for (const r of rows) if (r.option_index < counts.length) counts[r.option_index] = r.n;
    return {
      pollId: p.poll_id,
      question: p.question,
      options,
      counts,
      total: counts.reduce((a: number, b: number) => a + b, 0),
      endedAt: p.ended_at,
      correctOptions: (JSON.parse(p.correct || '[]') as number[]) ?? [],
    };
  });
}

export function bumpReaction(sessionId: number, emoji: string): void {
  getDb()
    .prepare(
      `INSERT INTO reaction_tallies (session_id, emoji, count) VALUES (@session_id, @emoji, 1)
       ON CONFLICT(session_id, emoji) DO UPDATE SET count = count + 1`
    )
    .run({ session_id: sessionId, emoji });
}

export function getReactionTallies(sessionId: number): Record<string, number> {
  const rows = getDb()
    .prepare('SELECT emoji, count FROM reaction_tallies WHERE session_id = ?')
    .all(sessionId) as { emoji: string; count: number }[];
  return Object.fromEntries(rows.map((r) => [r.emoji, r.count]));
}
