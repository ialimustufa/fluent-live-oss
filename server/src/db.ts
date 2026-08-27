import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { isGeneratedPdfUpload } from './uploads.js';

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
  presentation_mode: 'in_person' | 'remote';
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

export interface InitDbResult {
  database: Database.Database;
  pendingSlideRefs: string[];
}

export const RETIRED_DATA_COMPACTION_TASK = 'retired_public_data_compaction';

const RETIRED_DATA_TABLES = [
  'beta_leads',
  'trial_rate_limits',
  'trial_abuse_events',
] as const;

const RETIRED_SCHEMA_OBJECTS = [
  ...RETIRED_DATA_TABLES,
  'idx_trial_rate_limits_updated',
  'idx_trial_abuse_events_created',
  'idx_trial_abuse_events_ip',
  'idx_trial_abuse_events_email',
] as const;

interface LegacyTrialSchemaDetails {
  hasIsTrial: boolean;
  hasTrialType: boolean;
  objectNames: Set<string>;
  legacySessionCount: number;
  legacyTableRowCount: number;
}

export interface LegacyTrialSchemaInspection {
  migrationRequired: boolean;
  legacySessionCount: number;
  legacyTableRowCount: number;
}

function legacyTrialSchemaDetails(database: Database.Database): LegacyTrialSchemaDetails {
  const columns = database.prepare(`PRAGMA table_info(sessions)`).all() as { name: string }[];
  const hasIsTrial = columns.some((column) => column.name === 'is_trial');
  const hasTrialType = columns.some((column) => column.name === 'trial_type');
  const objectNames = new Set(
    (database
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE name IN (${RETIRED_SCHEMA_OBJECTS.map(() => '?').join(', ')})`
      )
      .all(...RETIRED_SCHEMA_OBJECTS) as { name: string }[]).map((row) => row.name)
  );

  const predicates: string[] = [];
  if (hasIsTrial) predicates.push('is_trial = 1');
  if (hasTrialType) predicates.push(`trial_type IN ('try', 'beta')`);
  const legacySessionCount = predicates.length
    ? Number(
        (database
          .prepare(`SELECT COUNT(*) AS count FROM sessions WHERE ${predicates.join(' OR ')}`)
          .get() as { count: number }).count
      )
    : 0;

  let legacyTableRowCount = 0;
  for (const table of RETIRED_DATA_TABLES) {
    if (!objectNames.has(table)) continue;
    legacyTableRowCount += Number(
      (database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count
    );
  }

  return {
    hasIsTrial,
    hasTrialType,
    objectNames,
    legacySessionCount,
    legacyTableRowCount,
  };
}

/** Read-only inspection used by preflight and upgrade tooling. */
export function inspectLegacyTrialSchema(
  database: Database.Database
): LegacyTrialSchemaInspection {
  const details = legacyTrialSchemaDetails(database);
  return {
    migrationRequired:
      details.hasIsTrial || details.hasTrialType || details.objectNames.size > 0,
    legacySessionCount: details.legacySessionCount,
    legacyTableRowCount: details.legacyTableRowCount,
  };
}

function queueSlideDeletionIfUnreferenced(database: Database.Database, slideRef: string): boolean {
  // External decks do not have an object managed by this application. Keep
  // unknown r2: refs visible for operator review, but never infer a key for
  // them or enqueue ordinary URLs as cleanup work.
  if (!isGeneratedPdfUpload(slideRef) && !slideRef.startsWith('r2:')) {
    database.prepare('DELETE FROM pending_slide_deletions WHERE slide_ref = ?').run(slideRef);
    return false;
  }
  const referenced = database
    .prepare('SELECT 1 FROM sessions WHERE slide_ref = ? LIMIT 1')
    .get(slideRef);
  if (referenced) {
    database.prepare('DELETE FROM pending_slide_deletions WHERE slide_ref = ?').run(slideRef);
    return false;
  }
  database
    .prepare('INSERT OR IGNORE INTO pending_slide_deletions (slide_ref) VALUES (?)')
    .run(slideRef);
  return true;
}

/**
 * Remove the retired public-access funnel from databases created by older
 * releases. DDL is transactional in SQLite, so session/child deletion and
 * schema removal either commit together or roll back together. Uploaded assets
 * live outside SQLite, so unreferenced objects are queued durably for cleanup.
 */
function scrubLegacyTrialSchema(database: Database.Database): void {
  const details = legacyTrialSchemaDetails(database);
  const { hasIsTrial, hasTrialType } = details;
  if (!hasIsTrial && !hasTrialType && details.objectNames.size === 0) return;

  const predicates: string[] = [];
  if (hasIsTrial) predicates.push('is_trial = 1');
  if (hasTrialType) predicates.push(`trial_type IN ('try', 'beta')`);

  const legacySessions = predicates.length
    ? database
        .prepare(`SELECT id, slide_ref FROM sessions WHERE ${predicates.join(' OR ')}`)
        .all() as { id: number; slide_ref: string }[]
    : [];

  database.transaction(() => {
    // Scrub deleted cells before they become freelist pages. A durable
    // compaction task below covers crashes between this commit and VACUUM.
    database.pragma('secure_delete = ON');
    const childTables = ['transcripts', 'attendees', 'poll_votes', 'polls', 'reaction_tallies'];
    for (const table of childTables) {
      const removeChildren = database.prepare(`DELETE FROM ${table} WHERE session_id = ?`);
      for (const session of legacySessions) removeChildren.run(session.id);
    }
    const removeSession = database.prepare('DELETE FROM sessions WHERE id = ?');
    for (const session of legacySessions) removeSession.run(session.id);

    // Queue only unreferenced objects. A retained session may legitimately
    // share a slide_ref, and must keep its deck.
    for (const slideRef of new Set(legacySessions.map((session) => session.slide_ref))) {
      queueSlideDeletionIfUnreferenced(database, slideRef);
    }

    database.exec(`
      DROP INDEX IF EXISTS idx_trial_rate_limits_updated;
      DROP INDEX IF EXISTS idx_trial_abuse_events_created;
      DROP INDEX IF EXISTS idx_trial_abuse_events_ip;
      DROP INDEX IF EXISTS idx_trial_abuse_events_email;
      DROP TABLE IF EXISTS beta_leads;
      DROP TABLE IF EXISTS trial_rate_limits;
      DROP TABLE IF EXISTS trial_abuse_events;
    `);
    if (hasIsTrial) database.exec(`ALTER TABLE sessions DROP COLUMN is_trial`);
    if (hasTrialType) database.exec(`ALTER TABLE sessions DROP COLUMN trial_type`);
    // Empty retired columns/tables do not leave sensitive content in free
    // pages, so they do not warrant a potentially expensive VACUUM.
    if (details.legacySessionCount > 0 || details.legacyTableRowCount > 0) {
      database
        .prepare(`INSERT OR IGNORE INTO database_maintenance_tasks (task) VALUES (?)`)
        .run(RETIRED_DATA_COMPACTION_TASK);
    }
  })();
}

export function initDb(databasePath: string): InitDbResult {
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
      peak_viewers INTEGER NOT NULL DEFAULT 0,
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

    CREATE TABLE IF NOT EXISTS pending_slide_deletions (
      slide_ref TEXT PRIMARY KEY,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS database_maintenance_tasks (
      task TEXT PRIMARY KEY,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

  `);

  // Migrations: add columns to pre-existing sessions tables.
  const cols = db.prepare(`PRAGMA table_info(sessions)`).all() as { name: string }[];
  if (!cols.some((c) => c.name === 'peak_viewers')) {
    db.exec(`ALTER TABLE sessions ADD COLUMN peak_viewers INTEGER NOT NULL DEFAULT 0`);
  }
  if (!cols.some((c) => c.name === 'presentation_mode')) {
    db.exec(`ALTER TABLE sessions ADD COLUMN presentation_mode TEXT NOT NULL DEFAULT 'in_person'`);
  }
  // polls.correct added after polls shipped without it.
  const pollCols = db.prepare(`PRAGMA table_info(polls)`).all() as { name: string }[];
  if (pollCols.length && !pollCols.some((c) => c.name === 'correct')) {
    db.exec(`ALTER TABLE polls ADD COLUMN correct TEXT NOT NULL DEFAULT '[]'`);
  }
  scrubLegacyTrialSchema(db);
  const pendingSlideRefs = listPendingSlideDeletions(db);
  return { database: db, pendingSlideRefs };
}

export function getDb(): Database.Database {
  if (!db) throw new Error('DB not initialized');
  return db;
}

export function completePendingSlideDeletion(slideRef: string): void {
  getDb().prepare('DELETE FROM pending_slide_deletions WHERE slide_ref = ?').run(slideRef);
}

export function listPendingSlideDeletions(
  database: Database.Database = getDb()
): string[] {
  return database
    .prepare('SELECT slide_ref FROM pending_slide_deletions ORDER BY created_at, slide_ref')
    .all()
    .map((row) => (row as { slide_ref: string }).slide_ref);
}

/**
 * Recheck a queued ref immediately before external deletion. If a session has
 * since attached the ref, the stale queue entry is removed instead.
 */
export function preparePendingSlideDeletion(slideRef: string): boolean {
  const database = getDb();
  return database.transaction(() => {
    const pending = database
      .prepare('SELECT 1 FROM pending_slide_deletions WHERE slide_ref = ?')
      .get(slideRef);
    if (!pending) return false;
    return queueSlideDeletionIfUnreferenced(database, slideRef);
  })();
}

/** Durably queue an uploaded object before attempting best-effort deletion. */
export function queuePendingSlideDeletion(slideRef: string): boolean {
  return queueSlideDeletionIfUnreferenced(getDb(), slideRef);
}

export interface DatabaseMaintenanceStatus {
  pendingSlideDeletionCount: number;
  compactionPending: boolean;
}

/** Read-only maintenance status for health/preflight reporting. */
export function inspectDatabaseMaintenance(
  database: Database.Database = getDb()
): DatabaseMaintenanceStatus {
  const pendingSlideDeletionCount = Number(
    (database.prepare('SELECT COUNT(*) AS count FROM pending_slide_deletions').get() as {
      count: number;
    }).count
  );
  const compactionPending = Boolean(
    database
      .prepare('SELECT 1 FROM database_maintenance_tasks WHERE task = ?')
      .get(RETIRED_DATA_COMPACTION_TASK)
  );
  return { pendingSlideDeletionCount, compactionPending };
}

/** Clear the durable marker only after offline compaction succeeds. */
export function completeRetiredDataCompaction(
  database: Database.Database = getDb()
): void {
  database
    .prepare('DELETE FROM database_maintenance_tasks WHERE task = ?')
    .run(RETIRED_DATA_COMPACTION_TASK);
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
  presentation_mode?: 'in_person' | 'remote';
}): SessionRow {
  const database = getDb();
  database.transaction(() => {
    database
      .prepare(
        `INSERT INTO sessions (slug, title, target_lang, slide_type, slide_ref, slide_count, echo_target_language, presentation_mode)
         VALUES (@slug, @title, @target_lang, @slide_type, @slide_ref, @slide_count, @echo, @presentation_mode)`
      )
      .run({
        ...row,
        echo: row.echo_target_language ? 1 : 0,
        presentation_mode: row.presentation_mode ?? 'in_person',
      });
    // A successful attachment supersedes any stale failed-cleanup entry for
    // the same ref, and both changes commit atomically.
    database.prepare('DELETE FROM pending_slide_deletions WHERE slide_ref = ?').run(row.slide_ref);
  })();
  return getSessionBySlug(row.slug)!;
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
       FROM sessions s ORDER BY datetime(s.created_at) DESC, s.id DESC`
    )
    .all() as (SessionRow & { attendee_count: number })[];
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
export function deleteSession(slug: string): {
  slide_ref: string;
  slide_type: string;
  cleanup_pending: boolean;
} | null {
  const s = getSessionBySlug(slug);
  if (!s) return null;
  const db = getDb();
  let cleanupPending = false;
  db.transaction(() => {
    db.prepare('DELETE FROM transcripts WHERE session_id = ?').run(s.id);
    db.prepare('DELETE FROM attendees WHERE session_id = ?').run(s.id);
    db.prepare('DELETE FROM poll_votes WHERE session_id = ?').run(s.id);
    db.prepare('DELETE FROM polls WHERE session_id = ?').run(s.id);
    db.prepare('DELETE FROM reaction_tallies WHERE session_id = ?').run(s.id);
    db.prepare('DELETE FROM sessions WHERE id = ?').run(s.id);
    // Only PDF sessions own a managed local/R2 object. Google Slides and HTML
    // sessions reference external URLs and need no storage maintenance.
    cleanupPending =
      s.slide_type === 'pdf' && queueSlideDeletionIfUnreferenced(db, s.slide_ref);
  })();
  return { slide_ref: s.slide_ref, slide_type: s.slide_type, cleanup_pending: cleanupPending };
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
