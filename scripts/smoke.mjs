/**
 * Smoke test for the acceptance criteria that are verifiable without a real
 * microphone or Gemini API key (#1 partial, #6, #7, #8, snapshot-on-join).
 * Run: node scripts/smoke.mjs
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import Database from 'better-sqlite3';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 3177;
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = 'test-secret-which-is-long-enough';
const DATA = path.join(ROOT, 'data', 'smoke');

const env = {
  ...process.env,
  NODE_ENV: 'test',
  HOST: '127.0.0.1',
  PORT: String(PORT),
  ADMIN_SECRET: SECRET,
  GEMINI_API_KEY: 'fake-key-for-smoke-test',
  DATABASE_PATH: path.join(DATA, 'app.db'),
  UPLOADS_DIR: path.join(DATA, 'uploads'),
  PUBLIC_ORIGIN: '',
  TRUST_PROXY: 'false',
  SENTRY_DSN: '',
  ENABLE_TEST_HOOKS: 'false',
  AUDIO_SYNC_METADATA: 'false',
  AUDIO_SUBSCRIPTION_ACTIVE: 'false',
  CF_REALTIME_APP_ID: '',
  CF_REALTIME_APP_SECRET: '',
  CF_REALTIME_APP_TOKEN: '',
  CF_REALTIME_API_BASE: '',
  R2_ACCOUNT_ID: '',
  R2_ACCESS_KEY_ID: '',
  R2_SECRET_ACCESS_KEY: '',
  R2_BUCKET: '',
  R2_PUBLIC_BASE_URL: '',
  R2_CACHE_PURGE_BASE_URLS: '',
  R2_CACHE_PURGE_ZONE_ID: '',
  R2_CACHE_PURGE_API_TOKEN: '',
  ASSET_CDN_BASE_URL: '',
  MAX_VIEWERS_PER_SESSION: '500',
  PUBLIC_GET_MAX: '2000',
};

let passed = 0;
let failed = 0;
function check(name, ok, extra = '') {
  if (ok) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.log(`  ❌ ${name} ${extra}`);
  }
}

function startServer(extraEnv = {}) {
  return spawn('node', ['server/dist/index.js'], {
    cwd: ROOT,
    env: { ...env, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function stopProcess(proc) {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  const exited = new Promise((resolve) => proc.once('exit', resolve));
  proc.kill();
  const killTimer = setTimeout(() => proc.kill('SIGKILL'), 12_000);
  killTimer.unref?.();
  await exited;
  clearTimeout(killTimer);
}

async function waitForHealth(timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/healthz`);
      if (res.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

async function waitUntil(fn, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

async function readJsonBody(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

async function startFakeRealtime({ connectBack = true } = {}) {
  const calls = [];
  const sockets = [];
  const ingestMessages = [];
  let sessionCounter = 0;
  let adapterCounter = 0;
  const server = http.createServer(async (req, res) => {
    try {
      const path = req.url ?? '';
      if (req.method !== 'POST' || !path.startsWith('/v1/apps/app-test/')) {
        res.writeHead(404).end();
        return;
      }
      if (req.headers.authorization !== 'Bearer fake-realtime-secret') {
        res.writeHead(401, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }

      const body = await readJsonBody(req);
      calls.push({ path, body });

      if (path.endsWith('/sessions/new')) {
        sessionCounter += 1;
        res
          .writeHead(200, { 'Content-Type': 'application/json' })
          .end(JSON.stringify({ sessionId: `session-${sessionCounter}` }));
        return;
      }
      if (path.endsWith('/adapters/websocket/new')) {
        const endpoint = body?.tracks?.[0]?.endpoint;
        adapterCounter += 1;
        if (connectBack && typeof endpoint === 'string') {
          setTimeout(() => {
            const ws = new WebSocket(endpoint.replace(/^wss:/, 'ws:'));
            sockets.push(ws);
            ws.on('message', (data) => ingestMessages.push(Buffer.from(data)));
            ws.on('error', () => {});
          }, 30);
        }
        res
          .writeHead(200, { 'Content-Type': 'application/json' })
          .end(
            JSON.stringify({
              tracks: [{ sessionId: `publisher-session-${adapterCounter}`, adapterId: `adapter-${adapterCounter}` }],
            })
          );
        return;
      }
      if (/\/sessions\/[^/]+\/tracks\/new$/.test(path)) {
        res
          .writeHead(200, { 'Content-Type': 'application/json' })
          .end(JSON.stringify({ sessionDescription: { type: 'answer', sdp: 'v=0\r\n' } }));
        return;
      }
      if (path.endsWith('/adapters/websocket/close')) {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true }));
        return;
      }
      res.writeHead(404).end();
    } catch (err) {
      res
        .writeHead(500, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return {
    base: `http://127.0.0.1:${address.port}/v1`,
    calls,
    ingestMessages,
    close: async () => {
      for (const ws of sockets) ws.close();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function startAudioFanoutHarness(fakeRealtime) {
  const { RealtimeAudioFanout } = await import(path.join(ROOT, 'server/dist/realtime-audio.js'));
  let fanout = null;
  const server = http.createServer((_req, res) => res.writeHead(404).end());
  server.on('upgrade', (req, socket, head) => {
    if (!fanout?.handleUpgrade(req, socket, head)) socket.destroy();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  fanout = new RealtimeAudioFanout({
    ...env,
    AUDIO_SUBSCRIPTION_ACTIVE: true,
    PUBLIC_ORIGIN: `http://127.0.0.1:${address.port}`,
    CF_REALTIME_APP_ID: 'app-test',
    CF_REALTIME_APP_SECRET: 'fake-realtime-secret',
    CF_REALTIME_API_BASE: fakeRealtime.base,
  });
  return {
    fanout,
    close: async (slugs = []) => {
      for (const slug of slugs) await fanout.close(slug);
      fanout.closeAll();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function wsOpen(slug, hello, opts = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/${slug}`);
    const messages = [];
    let closeCode = null;
    let settled = false;
    const timeout = setTimeout(finish, opts.timeoutMs ?? 5000);

    function finish() {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ ws, messages, closeCode: () => closeCode });
    }

    ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', ts: 0, seq: 0, payload: hello })));
    ws.on('message', (d) => {
      const msg = JSON.parse(d.toString());
      messages.push(msg);
      if (msg.type === 'snapshot') finish();
    });
    ws.on('close', (code) => {
      closeCode = code;
      finish();
    });
  });
}

function seedAttendees(slug, count) {
  const db = new Database(env.DATABASE_PATH);
  try {
    const session = db.prepare('SELECT id FROM sessions WHERE slug = ?').get(slug);
    if (!session?.id) throw new Error(`session not found for attendee seed: ${slug}`);
    const stmt = db.prepare(
      `INSERT OR IGNORE INTO attendees (session_id, viewer_id, name, company, joins, total_ms)
       VALUES (@session_id, @viewer_id, @name, @company, 1, @total_ms)`
    );
    db.transaction(() => {
      for (let i = 0; i < count; i++) {
        stmt.run({
          session_id: session.id,
          viewer_id: `seed-${i}`,
          name: `Seed ${i}`,
          company: 'Smoke',
          total_ms: count - i,
        });
      }
    })();
  } finally {
    db.close();
  }
}

function makePdf(text = 'Smoke Talk') {
  const stream = `BT /F1 24 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (let i = 0; i < objects.length; i += 1) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i < offsets.length; i += 1) {
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return pdf;
}

function makePcm24kToneBase64(durationMs = 1000) {
  const samples = Math.round((24000 * durationMs) / 1000);
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    const value = Math.round(Math.sin((i / 24000) * 2 * Math.PI * 440) * 12000);
    buf.writeInt16LE(value, i * 2);
  }
  return buf.toString('base64');
}

const MINI_PDF = makePdf();

fs.rmSync(DATA, { recursive: true, force: true });

// ---- Test 0: additive migration preserves existing sessions as audience-enabled
console.log('\n[0] Legacy database migration');
{
  fs.mkdirSync(DATA, { recursive: true });
  const legacyPath = path.join(DATA, 'legacy-migration.db');
  const legacy = new Database(legacyPath);
  legacy.exec(`
    CREATE TABLE sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL DEFAULT '',
      target_lang TEXT NOT NULL,
      slide_type TEXT NOT NULL,
      slide_ref TEXT NOT NULL,
      slide_count INTEGER,
      echo_target_language INTEGER NOT NULL DEFAULT 0,
      state TEXT NOT NULL DEFAULT 'created',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      started_at TEXT,
      ended_at TEXT,
      presentation_mode TEXT NOT NULL DEFAULT 'in_person'
    );
    INSERT INTO sessions (slug, title, target_lang, slide_type, slide_ref)
    VALUES ('legacy01', 'Legacy talk', 'es', 'html', 'https://example.com/legacy.html');
  `);
  legacy.close();
  const { initDb } = await import(path.join(ROOT, 'server/dist/db.js'));
  const { database: migrated } = initDb(legacyPath);
  const migratedRow = migrated.prepare('SELECT audience_enabled FROM sessions WHERE slug = ?').get('legacy01');
  const migratedColumns = migrated.prepare('PRAGMA table_info(sessions)').all();
  check(
    'audience_enabled is added with a safe backward-compatible default',
    migratedColumns.some((column) => column.name === 'audience_enabled') && migratedRow?.audience_enabled === 1,
    JSON.stringify({ migratedRow, columns: migratedColumns.map((column) => column.name) })
  );
  migrated.close();
}

// ---- Test 0a: speaker-only rooms keep translated audio on the host socket
console.log('\n[0a] Speaker-only room fanout isolation');
{
  const roomDbPath = path.join(DATA, 'speaker-room.db');
  const dbModule = await import(path.join(ROOT, 'server/dist/db.js'));
  const { database: roomDb } = dbModule.initDb(roomDbPath);
  const session = dbModule.createSession({
    slug: 'localroom01',
    title: 'Local room',
    target_lang: 'es',
    slide_type: 'html',
    slide_ref: 'https://example.com/local-room.html',
    slide_count: null,
    echo_target_language: false,
    presentation_mode: 'in_person',
    audience_enabled: false,
  });
  const { Room, configureRooms } = await import(path.join(ROOT, 'server/dist/rooms.js'));
  const fanoutCalls = { start: 0, publish: 0, close: 0 };
  const fakeFanout = {
    startSession: async () => { fanoutCalls.start += 1; },
    publishTranslated: () => { fanoutCalls.publish += 1; },
    close: async () => { fanoutCalls.close += 1; },
    queueDepthMs: () => 0,
  };
  configureRooms('smoke-key', Infinity, fakeFanout);
  const hostMessages = [];
  const room = new Room(session, 'smoke-key');
  room.host = {
    OPEN: 1,
    readyState: 1,
    bufferedAmount: 0,
    send: (message) => hostMessages.push(JSON.parse(String(message))),
    close: () => {},
  };
  const bridgeWithEvents = room.createBridge();
  room.createBridge = () => ({ start: async () => {}, close: () => {} });
  room.start();
  bridgeWithEvents.events.onAudio('AA==');
  room.stop();
  await new Promise((resolve) => setImmediate(resolve));
  check(
    'speaker-only room skips SFU lifecycle while translated audio reaches the host',
    fanoutCalls.start === 0 &&
      fanoutCalls.publish === 0 &&
      fanoutCalls.close === 0 &&
      hostMessages.some((message) => message.type === 'audio.out' && message.payload?.data === 'AA=='),
    JSON.stringify({ fanoutCalls, hostMessages })
  );
  bridgeWithEvents.close();
  configureRooms('', Infinity, null);
  roomDb.close();
}

// ---- Test 0b: SFU packet framing carries correct real-time durations
// (the pacer feeds the SFU at 1× using these durations, so they must be exact).
console.log('\n[0b] SFU audio packet pacing math');
{
  const { pcm24kMonoBase64ToSfuFrames, decodeSfuPacket } = await import(
    path.join(ROOT, 'server/dist/audio-packet.js')
  );
  // 1000 ms of 24 kHz mono 16-bit silence = 24000 samples * 2 bytes.
  const oneSecond = Buffer.alloc(24000 * 2).toString('base64');
  const frames = pcm24kMonoBase64ToSfuFrames(oneSecond);
  const totalMs = frames.reduce((s, f) => s + f.durationMs, 0);
  check('frame durations sum to the input duration (±1ms)', Math.abs(totalMs - 1000) <= 1, `(got ${Math.round(totalMs)}ms)`);
  const payloads = frames.map((f) => decodeSfuPacket(f.packet));
  check('every frame decodes to a payload', payloads.every((p) => p && p.length > 0));
  check('payloads are 20ms live frames and whole stereo frames',
    payloads.every((p, i) => p.length % 4 === 0 && (p.length === 3840 || i === payloads.length - 1)));
  // 1s of 48kHz stereo 16-bit = 192000 bytes; durations derive from payload bytes.
  const totalBytes = payloads.reduce((s, p) => s + p.length, 0);
  check('upsampled payload totals 1s of 48kHz stereo (192000 bytes)', totalBytes === 192000, `(got ${totalBytes})`);
  check('empty input yields no frames', pcm24kMonoBase64ToSfuFrames('') .length === 0);
}

// ---- Test 0a: upgrading a legacy database removes only retired trial data.
console.log('\n[0a] Legacy trial schema retirement');
{
  const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluent-legacy-migration-'));
  const legacyPath = path.join(legacyDir, 'app.db');
  let openDb = null;

  try {
    openDb = new Database(legacyPath);
    openDb.exec(`
      CREATE TABLE sessions (
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
        is_trial INTEGER NOT NULL DEFAULT 0,
        trial_type TEXT NOT NULL DEFAULT 'none',
        presentation_mode TEXT NOT NULL DEFAULT 'in_person'
      );
      CREATE TABLE transcripts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER NOT NULL REFERENCES sessions(id),
        kind TEXT NOT NULL,
        language_code TEXT NOT NULL,
        text TEXT NOT NULL,
        is_final INTEGER NOT NULL DEFAULT 1,
        t_offset_ms INTEGER NOT NULL,
        slide_index INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE attendees (
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
      CREATE TABLE polls (
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
      CREATE TABLE poll_votes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER NOT NULL REFERENCES sessions(id),
        poll_id TEXT NOT NULL,
        viewer_id TEXT NOT NULL,
        option_index INTEGER NOT NULL,
        voted_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(session_id, poll_id, viewer_id)
      );
      CREATE TABLE reaction_tallies (
        session_id INTEGER NOT NULL REFERENCES sessions(id),
        emoji TEXT NOT NULL,
        count INTEGER NOT NULL DEFAULT 0,
        UNIQUE(session_id, emoji)
      );
      CREATE TABLE beta_leads (id INTEGER PRIMARY KEY, email TEXT NOT NULL);
      CREATE TABLE trial_rate_limits (scope TEXT NOT NULL, key_hash TEXT NOT NULL);
      CREATE TABLE trial_abuse_events (id INTEGER PRIMARY KEY, detail TEXT NOT NULL);

      INSERT INTO sessions (
        id, slug, title, target_lang, slide_type, slide_ref, is_trial, trial_type
      ) VALUES
        (1, 'normal-row', 'Normal session', 'es', 'pdf', 'normal-slide.pdf', 0, 'none'),
        (2, 'legacy-try', 'Legacy own-key trial', 'es', 'pdf', 'aaaaaaaaaaaa.pdf', 1, 'try'),
        (3, 'legacy-beta', 'Legacy hosted trial', 'es', 'pdf', 'bbbbbbbbbbbb.pdf', 1, 'beta'),
        (4, 'normal-shared', 'Normal shared deck', 'es', 'pdf', 'bbbbbbbbbbbb.pdf', 0, 'none');

      INSERT INTO transcripts (session_id, kind, language_code, text, t_offset_ms)
        VALUES (1, 'input', 'en', 'keep transcript', 1),
               (2, 'input', 'en', 'remove try transcript', 2),
               (3, 'input', 'en', 'remove beta transcript', 3);
      INSERT INTO attendees (session_id, viewer_id, name, joins)
        VALUES (1, 'keep-viewer', 'Keep', 1),
               (2, 'try-viewer', 'Remove', 1),
               (3, 'beta-viewer', 'Remove', 1);
      INSERT INTO polls (session_id, poll_id, question, options)
        VALUES (1, 'keep-poll', 'Keep?', '["Yes","No"]'),
               (2, 'try-poll', 'Remove?', '["Yes","No"]'),
               (3, 'beta-poll', 'Remove?', '["Yes","No"]');
      INSERT INTO poll_votes (session_id, poll_id, viewer_id, option_index)
        VALUES (1, 'keep-poll', 'keep-viewer', 0),
               (2, 'try-poll', 'try-viewer', 0),
               (3, 'beta-poll', 'beta-viewer', 0);
      INSERT INTO reaction_tallies (session_id, emoji, count)
        VALUES (1, '👍', 1), (2, '👍', 2), (3, '👍', 3);
      INSERT INTO beta_leads VALUES (1, 'historical@example.com');
      INSERT INTO trial_rate_limits VALUES ('legacy', 'hash');
      INSERT INTO trial_abuse_events VALUES (1, 'historical audit');
    `);
    openDb.close();
    openDb = null;

    const { completePendingSlideDeletion, initDb } = await import(path.join(ROOT, 'server/dist/db.js'));
    const first = initDb(legacyPath);
    openDb = first.database;

    const remainingSessions = openDb
      .prepare('SELECT id, slug, title FROM sessions ORDER BY id')
      .all();
    const childTables = ['transcripts', 'attendees', 'poll_votes', 'polls', 'reaction_tallies'];
    const childRows = Object.fromEntries(
      childTables.map((table) => [
        table,
        openDb.prepare(`SELECT COUNT(*) AS count, MIN(session_id) AS min_id, MAX(session_id) AS max_id FROM ${table}`).get(),
      ])
    );
    check(
      'migration removes legacy sessions/children and preserves normal rows',
      JSON.stringify(remainingSessions) === JSON.stringify([
        { id: 1, slug: 'normal-row', title: 'Normal session' },
        { id: 4, slug: 'normal-shared', title: 'Normal shared deck' },
      ]) &&
        Object.values(childRows).every((row) => row.count === 1 && row.min_id === 1 && row.max_id === 1),
      JSON.stringify({ remainingSessions, childRows })
    );

    const sessionColumns = openDb.prepare('PRAGMA table_info(sessions)').all().map((column) => column.name);
    const remainingTables = new Set(
      openDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name)
    );
    check(
      'migration removes retired tables and session columns',
      !sessionColumns.includes('is_trial') &&
        !sessionColumns.includes('trial_type') &&
        !remainingTables.has('beta_leads') &&
        !remainingTables.has('trial_rate_limits') &&
        !remainingTables.has('trial_abuse_events'),
      JSON.stringify({ sessionColumns, remainingTables: [...remainingTables].sort() })
    );
    check(
      'migration queues only unreferenced retired slide cleanup refs',
      JSON.stringify(first.pendingSlideRefs) === JSON.stringify(['aaaaaaaaaaaa.pdf']),
      JSON.stringify(first.pendingSlideRefs)
    );
    check(
      'logical migration queues physical compaction without running it at startup',
      openDb
        .prepare("SELECT COUNT(*) AS count FROM database_maintenance_tasks WHERE task = 'retired_public_data_compaction'")
        .get().count === 1
    );

    openDb.close();
    openDb = null;

    const second = initDb(legacyPath);
    openDb = second.database;
    const secondSessions = openDb.prepare('SELECT id, slug FROM sessions ORDER BY id').all();
    const secondChildCounts = childTables.map((table) =>
      openDb.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count
    );
    const secondColumns = openDb.prepare('PRAGMA table_info(sessions)').all().map((column) => column.name);
    check(
      'legacy migration is idempotent and retains failed cleanup work for retry',
      JSON.stringify(second.pendingSlideRefs) === JSON.stringify(['aaaaaaaaaaaa.pdf']) &&
        JSON.stringify(secondSessions) === JSON.stringify([
          { id: 1, slug: 'normal-row' },
          { id: 4, slug: 'normal-shared' },
        ]) &&
        secondChildCounts.every((count) => count === 1) &&
        !secondColumns.includes('is_trial') &&
        !secondColumns.includes('trial_type') &&
        openDb
          .prepare("SELECT COUNT(*) AS count FROM database_maintenance_tasks WHERE task = 'retired_public_data_compaction'")
          .get().count === 1,
      JSON.stringify({ refs: second.pendingSlideRefs, secondSessions, secondChildCounts, secondColumns })
    );
    completePendingSlideDeletion('aaaaaaaaaaaa.pdf');
    check(
      'completed slide cleanup is removed from the durable retry queue',
      openDb.prepare('SELECT COUNT(*) AS count FROM pending_slide_deletions').get().count === 0
    );
    openDb.close();
    openDb = null;

    const compactOutput = execFileSync(
      'node',
      [path.join(ROOT, 'server/dist/compact.js')],
      {
        cwd: ROOT,
        env: { ...env, DATABASE_PATH: legacyPath, UPLOADS_DIR: legacyDir },
        encoding: 'utf8',
      }
    );
    openDb = new Database(legacyPath, { readonly: true });
    const compactedDbBytes = fs.readFileSync(legacyPath).toString('latin1');
    check(
      'offline maintenance compacts sensitive free pages and clears its task',
      compactOutput.includes('"compacted":true') &&
        openDb
          .prepare("SELECT COUNT(*) AS count FROM database_maintenance_tasks WHERE task = 'retired_public_data_compaction'")
          .get().count === 0 &&
        !compactedDbBytes.includes('historical@example.com') &&
        !compactedDbBytes.includes('historical audit'),
      compactOutput.trim()
    );
    openDb.close();
    openDb = null;

    const emptyLegacyPath = path.join(legacyDir, 'empty-legacy.db');
    initDb(emptyLegacyPath).database.close();
    openDb = new Database(emptyLegacyPath);
    openDb.exec(`
      ALTER TABLE sessions ADD COLUMN is_trial INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE sessions ADD COLUMN trial_type TEXT;
      CREATE TABLE beta_leads (id INTEGER PRIMARY KEY, email TEXT NOT NULL);
    `);
    openDb.close();
    openDb = null;
    const emptyUpgrade = initDb(emptyLegacyPath);
    openDb = emptyUpgrade.database;
    check(
      'empty retired schema is removed without scheduling VACUUM',
      openDb
        .prepare("SELECT COUNT(*) AS count FROM database_maintenance_tasks WHERE task = 'retired_public_data_compaction'")
        .get().count === 0
    );
    openDb.close();
    openDb = null;

    const isTrialOnlyPath = path.join(legacyDir, 'is-trial-only.db');
    initDb(isTrialOnlyPath).database.close();
    openDb = new Database(isTrialOnlyPath);
    openDb.exec(`
      ALTER TABLE sessions ADD COLUMN is_trial INTEGER NOT NULL DEFAULT 0;
      INSERT INTO sessions (slug, title, target_lang, slide_type, slide_ref, is_trial)
        VALUES ('is-trial-keep', 'Keep', 'es', 'pdf', 'normal-slide.pdf', 0),
               ('is-trial-remove', 'Remove', 'es', 'pdf', 'cccccccccccc.pdf', 1);
    `);
    openDb.close();
    openDb = null;
    const isTrialOnlyUpgrade = initDb(isTrialOnlyPath);
    openDb = isTrialOnlyUpgrade.database;
    const isTrialOnlyColumns = openDb
      .prepare('PRAGMA table_info(sessions)')
      .all()
      .map((column) => column.name);
    check(
      'is_trial-only legacy schema deletes marked sessions and migrates cleanly',
      JSON.stringify(openDb.prepare('SELECT slug FROM sessions ORDER BY slug').all()) ===
        JSON.stringify([{ slug: 'is-trial-keep' }]) &&
        !isTrialOnlyColumns.includes('is_trial') &&
        JSON.stringify(isTrialOnlyUpgrade.pendingSlideRefs) === JSON.stringify(['cccccccccccc.pdf']) &&
        openDb
          .prepare("SELECT COUNT(*) AS count FROM database_maintenance_tasks WHERE task = 'retired_public_data_compaction'")
          .get().count === 1,
      JSON.stringify({ columns: isTrialOnlyColumns, refs: isTrialOnlyUpgrade.pendingSlideRefs })
    );
    openDb.close();
    openDb = null;

    const trialTypeOnlyPath = path.join(legacyDir, 'trial-type-only.db');
    initDb(trialTypeOnlyPath).database.close();
    openDb = new Database(trialTypeOnlyPath);
    openDb.exec(`
      ALTER TABLE sessions ADD COLUMN trial_type TEXT;
      INSERT INTO sessions (slug, title, target_lang, slide_type, slide_ref, trial_type)
        VALUES ('trial-type-keep', 'Keep', 'es', 'pdf', 'normal-slide.pdf', NULL),
               ('trial-type-remove', 'Remove', 'es', 'pdf', 'dddddddddddd.pdf', 'beta');
    `);
    openDb.close();
    openDb = null;
    const trialTypeOnlyUpgrade = initDb(trialTypeOnlyPath);
    openDb = trialTypeOnlyUpgrade.database;
    const trialTypeOnlyColumns = openDb
      .prepare('PRAGMA table_info(sessions)')
      .all()
      .map((column) => column.name);
    check(
      'trial_type-only legacy schema deletes marked sessions and migrates cleanly',
      JSON.stringify(openDb.prepare('SELECT slug FROM sessions ORDER BY slug').all()) ===
        JSON.stringify([{ slug: 'trial-type-keep' }]) &&
        !trialTypeOnlyColumns.includes('trial_type') &&
        JSON.stringify(trialTypeOnlyUpgrade.pendingSlideRefs) === JSON.stringify(['dddddddddddd.pdf']) &&
        openDb
          .prepare("SELECT COUNT(*) AS count FROM database_maintenance_tasks WHERE task = 'retired_public_data_compaction'")
          .get().count === 1,
      JSON.stringify({ columns: trialTypeOnlyColumns, refs: trialTypeOnlyUpgrade.pendingSlideRefs })
    );
    openDb.close();
    openDb = null;

    const tablesOnlyPath = path.join(legacyDir, 'tables-only.db');
    initDb(tablesOnlyPath).database.close();
    openDb = new Database(tablesOnlyPath);
    openDb.exec(`
      INSERT INTO sessions (slug, title, target_lang, slide_type, slide_ref)
        VALUES ('tables-only-keep', 'Keep', 'es', 'pdf', 'normal-slide.pdf');
      CREATE TABLE beta_leads (id INTEGER PRIMARY KEY, email TEXT NOT NULL);
      CREATE TABLE trial_rate_limits (scope TEXT NOT NULL, key_hash TEXT NOT NULL);
      CREATE TABLE trial_abuse_events (id INTEGER PRIMARY KEY, detail TEXT NOT NULL);
      INSERT INTO beta_leads (email) VALUES ('tables-only@example.invalid');
    `);
    openDb.close();
    openDb = null;
    const tablesOnlyUpgrade = initDb(tablesOnlyPath);
    openDb = tablesOnlyUpgrade.database;
    const tablesAfterUpgrade = new Set(
      openDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name)
    );
    check(
      'retired tables-only schema is scrubbed without deleting current sessions',
      openDb.prepare('SELECT COUNT(*) AS count FROM sessions WHERE slug = ?').get('tables-only-keep').count === 1 &&
        !tablesAfterUpgrade.has('beta_leads') &&
        !tablesAfterUpgrade.has('trial_rate_limits') &&
        !tablesAfterUpgrade.has('trial_abuse_events') &&
        tablesOnlyUpgrade.pendingSlideRefs.length === 0 &&
        openDb
          .prepare("SELECT COUNT(*) AS count FROM database_maintenance_tasks WHERE task = 'retired_public_data_compaction'")
          .get().count === 1,
      JSON.stringify({ tables: [...tablesAfterUpgrade].sort(), refs: tablesOnlyUpgrade.pendingSlideRefs })
    );
    openDb.close();
    openDb = null;

    const currentPath = path.join(legacyDir, 'already-current.db');
    openDb = initDb(currentPath).database;
    openDb
      .prepare(
        `INSERT INTO sessions (slug, title, target_lang, slide_type, slide_ref)
         VALUES (?, ?, 'es', 'pdf', ?)`
      )
      .run('current-keep', 'Current', 'normal-slide.pdf');
    openDb.close();
    openDb = null;
    const currentUpgrade = initDb(currentPath);
    openDb = currentUpgrade.database;
    const currentColumns = openDb
      .prepare('PRAGMA table_info(sessions)')
      .all()
      .map((column) => column.name);
    check(
      'already-current schema is a no-op with no cleanup or compaction',
      openDb.prepare('SELECT COUNT(*) AS count FROM sessions WHERE slug = ?').get('current-keep').count === 1 &&
        !currentColumns.includes('is_trial') &&
        !currentColumns.includes('trial_type') &&
        currentUpgrade.pendingSlideRefs.length === 0 &&
        openDb
          .prepare("SELECT COUNT(*) AS count FROM database_maintenance_tasks WHERE task = 'retired_public_data_compaction'")
          .get().count === 0,
      JSON.stringify({ columns: currentColumns, refs: currentUpgrade.pendingSlideRefs })
    );
    openDb.close();
    openDb = null;

    const lockedPath = path.join(legacyDir, 'locked-compaction.db');
    openDb = initDb(lockedPath).database;
    openDb
      .prepare('INSERT INTO database_maintenance_tasks (task) VALUES (?)')
      .run('retired_public_data_compaction');
    openDb.exec('BEGIN EXCLUSIVE');
    const lockedCompaction = spawnSync(
      'node',
      [path.join(ROOT, 'server/dist/compact.js')],
      {
        cwd: ROOT,
        env: { ...env, DATABASE_PATH: lockedPath, UPLOADS_DIR: legacyDir },
        encoding: 'utf8',
        timeout: 10_000,
      }
    );
    const retainedTask = openDb
      .prepare("SELECT COUNT(*) AS count FROM database_maintenance_tasks WHERE task = 'retired_public_data_compaction'")
      .get().count;
    openDb.exec('ROLLBACK');
    check(
      'offline compaction lock failure is non-destructive and leaves its task queued',
      lockedCompaction.status !== 0 && retainedTask === 1,
      `${lockedCompaction.stdout}\n${lockedCompaction.stderr}`
    );
    openDb.close();
    openDb = null;
    const lockRetry = spawnSync(
      'node',
      [path.join(ROOT, 'server/dist/compact.js')],
      {
        cwd: ROOT,
        env: { ...env, DATABASE_PATH: lockedPath, UPLOADS_DIR: legacyDir },
        encoding: 'utf8',
        timeout: 10_000,
      }
    );
    openDb = new Database(lockedPath, { readonly: true });
    const taskAfterLockRetry = openDb
      .prepare("SELECT COUNT(*) AS count FROM database_maintenance_tasks WHERE task = 'retired_public_data_compaction'")
      .get().count;
    check(
      'offline compaction succeeds on retry after the lock is released',
      lockRetry.status === 0 && taskAfterLockRetry === 0,
      `${lockRetry.stdout}\n${lockRetry.stderr}`
    );
    openDb.close();
    openDb = null;

    const insufficientPath = path.join(legacyDir, 'insufficient-space.db');
    openDb = initDb(insufficientPath).database;
    openDb
      .prepare('INSERT INTO database_maintenance_tasks (task) VALUES (?)')
      .run('retired_public_data_compaction');
    openDb.pragma('wal_checkpoint(TRUNCATE)');
    openDb.close();
    openDb = null;
    const compactDbBytes = fs.statSync(insufficientPath).size;
    const diskStats = fs.statfsSync(legacyDir, { bigint: true });
    const freeBytes = diskStats.bavail * diskStats.bsize;
    const sparseBytes = freeBytes / 2n + 1024n * 1024n;
    if (sparseBytes > BigInt(Number.MAX_SAFE_INTEGER)) {
      check('offline compaction rejects insufficient free space without clearing its task', false, 'filesystem is too large for a safe sparse fixture');
    } else {
      fs.truncateSync(insufficientPath, Number(sparseBytes));
      const insufficientCompaction = spawnSync(
        'node',
        [path.join(ROOT, 'server/dist/compact.js')],
        {
          cwd: ROOT,
          env: { ...env, DATABASE_PATH: insufficientPath, UPLOADS_DIR: legacyDir },
          encoding: 'utf8',
          timeout: 10_000,
        }
      );
      openDb = new Database(insufficientPath, { readonly: true });
      const taskAfterSpaceFailure = openDb
        .prepare("SELECT COUNT(*) AS count FROM database_maintenance_tasks WHERE task = 'retired_public_data_compaction'")
        .get().count;
      openDb.close();
      openDb = null;
      check(
        'offline compaction rejects insufficient free space without clearing its task',
        insufficientCompaction.status !== 0 &&
          insufficientCompaction.stderr.includes('insufficient free space') &&
          taskAfterSpaceFailure === 1,
        `${insufficientCompaction.stdout}\n${insufficientCompaction.stderr}`
      );

      fs.truncateSync(insufficientPath, compactDbBytes);
      const spaceRetry = spawnSync(
        'node',
        [path.join(ROOT, 'server/dist/compact.js')],
        {
          cwd: ROOT,
          env: { ...env, DATABASE_PATH: insufficientPath, UPLOADS_DIR: legacyDir },
          encoding: 'utf8',
          timeout: 10_000,
        }
      );
      openDb = new Database(insufficientPath, { readonly: true });
      const taskAfterSpaceRetry = openDb
        .prepare("SELECT COUNT(*) AS count FROM database_maintenance_tasks WHERE task = 'retired_public_data_compaction'")
        .get().count;
      check(
        'offline compaction succeeds after free-space pressure is removed',
        spaceRetry.status === 0 && taskAfterSpaceRetry === 0,
        `${spaceRetry.stdout}\n${spaceRetry.stderr}`
      );
      openDb.close();
      openDb = null;
    }
  } finally {
    openDb?.close();
    fs.rmSync(legacyDir, { recursive: true, force: true });
  }
}

// ---- Test 0b: R2 deletion is not complete until every public cache is purged.
console.log('\n[0b] R2 PDF deletion and cache retirement');
{
  const { S3Client } = await import('@aws-sdk/client-s3');
  const { createSlideStorage } = await import(path.join(ROOT, 'server/dist/storage.js'));
  const originalSend = S3Client.prototype.send;
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluent-r2-storage-'));
  const sentCommands = [];
  const purgeCalls = [];

  try {
    S3Client.prototype.send = async function send(command) {
      sentCommands.push(command);
      const body = command.input?.Body;
      if (body && typeof body[Symbol.asyncIterator] === 'function') {
        for await (const _chunk of body) {
          // Consume the mocked upload stream before uploadPdf unlinks the file.
        }
      }
      return {};
    };
    globalThis.fetch = async (url, options) => {
      purgeCalls.push({ url: String(url), options });
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const storage = createSlideStorage({
      UPLOADS_DIR: tempDir,
      R2_ACCOUNT_ID: 'test-account',
      R2_ACCESS_KEY_ID: 'test-access-key',
      R2_SECRET_ACCESS_KEY: 'test-secret-key',
      R2_BUCKET: 'test-bucket',
      R2_PUBLIC_BASE_URL: 'https://current-cdn.example.com',
      R2_CACHE_PURGE_BASE_URLS: [
        'https://current-cdn.example.com',
        'https://old-cdn.example.com',
      ],
      R2_CACHE_PURGE_ZONE_ID: 'test-zone',
      R2_CACHE_PURGE_API_TOKEN: 'test-purge-token',
    });
    const tmpPdf = path.join(tempDir, 'upload.pdf');
    fs.writeFileSync(tmpPdf, MINI_PDF);
    const ref = await storage.uploadPdf(tmpPdf, 'cccccccccccc.pdf');
    const completed = await storage.removeMany([
      ref,
      'r2:slides/dddddddddddd.pdf',
    ]);
    const putCommand = sentCommands.find((command) => command.constructor.name === 'PutObjectCommand');
    const purgePrefixes = purgeCalls
      .flatMap((call) => JSON.parse(call.options.body).prefixes ?? [])
      .sort();

    check(
      'new R2 PDFs prohibit shared/browser caching',
      putCommand?.input?.CacheControl === 'private, no-store, max-age=0',
      `(got ${putCommand?.input?.CacheControl ?? 'missing'})`
    );
    check(
      'R2 cleanup purges all current/historical cache-key variants before completion',
      completed.size === 2 &&
        purgeCalls.length === 1 &&
        purgeCalls.every(
          (call) =>
            call.url.endsWith('/zones/test-zone/purge_cache') &&
            call.options.headers.Authorization === 'Bearer test-purge-token'
        ) &&
        JSON.stringify(purgePrefixes) ===
          JSON.stringify([
            'current-cdn.example.com/slides/cccccccccccc.pdf',
            'current-cdn.example.com/slides/dddddddddddd.pdf',
            'old-cdn.example.com/slides/cccccccccccc.pdf',
            'old-cdn.example.com/slides/dddddddddddd.pdf',
          ]),
      JSON.stringify({ completed: [...completed], purgePrefixes })
    );

    const commandCountBeforeInvalid = sentCommands.length;
    const purgeCountBeforeInvalid = purgeCalls.length;
    const invalidCompleted = await storage.removeMany([
      'r2:assets/index.js',
      'r2:slides/not-generated.pdf',
      'r2:slides/../../shared.pdf',
      'https://external.example.test/deck.pdf',
    ]);
    check(
      'R2 cleanup rejects unmanaged keys while external URLs are safe no-ops',
      invalidCompleted.size === 1 &&
        invalidCompleted.has('https://external.example.test/deck.pdf') &&
        sentCommands.length === commandCountBeforeInvalid &&
        purgeCalls.length === purgeCountBeforeInvalid,
      JSON.stringify({ completed: [...invalidCompleted] })
    );

    console.warn = () => {};
    purgeCalls.length = 0;
    let purgeAttempt = 0;
    globalThis.fetch = async (url, options) => {
      purgeCalls.push({ url: String(url), options });
      purgeAttempt += 1;
      return purgeAttempt === 1
        ? new Response(JSON.stringify({ success: true }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        : new Response(JSON.stringify({ success: false, errors: [{ code: 1015, message: 'rate limited' }] }), {
            status: 429,
            headers: { 'Content-Type': 'application/json', 'Retry-After': '60' },
          });
    };
    const bulkRefs = Array.from(
      { length: 51 },
      (_, index) => `r2:slides/${String(index).padStart(12, '0')}.pdf`
    );
    const bulkCompleted = await storage.removeMany(bulkRefs);
    check(
      'batched 429 preserves successful progress and retries only the failed group',
      bulkCompleted.size === 50 &&
        bulkRefs.slice(0, 50).every((ref) => bulkCompleted.has(ref)) &&
        !bulkCompleted.has(bulkRefs[50]) &&
        JSON.stringify(purgeCalls.map((call) => JSON.parse(call.options.body).prefixes.length)) ===
          JSON.stringify([100, 2]),
      JSON.stringify({ completed: [...bulkCompleted], batches: purgeCalls.length })
    );
  } finally {
    S3Client.prototype.send = originalSend;
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

// ---- Test 0c: finalized uploads remain durably queued when session creation fails.
console.log('\n[0c] Failed create keeps durable deck cleanup');
{
  const Fastify = (await import('fastify')).default;
  const fastifyMultipart = (await import('@fastify/multipart')).default;
  const { initDb } = await import(path.join(ROOT, 'server/dist/db.js'));
  const { registerRoutes } = await import(path.join(ROOT, 'server/dist/routes.js'));
  const createFailureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluent-create-failure-'));
  const createFailureDbPath = path.join(createFailureDir, 'app.db');
  const createFailureUploads = path.join(createFailureDir, 'uploads');
  const forcedRef = 'r2:slides/gggggggggggg.pdf';
  let openDb = null;
  let removeCalls = 0;
  let wakeCalls = 0;
  const app = Fastify({ logger: false });

  try {
    fs.mkdirSync(createFailureUploads, { recursive: true });
    openDb = initDb(createFailureDbPath).database;
    openDb.exec(`
      CREATE TRIGGER force_session_insert_failure
      BEFORE INSERT ON sessions
      BEGIN
        SELECT RAISE(ABORT, 'forced create failure');
      END;
    `);
    await app.register(fastifyMultipart, { limits: { fileSize: 1024 * 1024, files: 1 } });
    registerRoutes(app, {
      ...env,
      ADMIN_SECRET: SECRET,
      PUBLIC_GET_MAX: 2000,
      PUBLIC_ORIGIN: null,
    }, {
      slideStorage: {
        mode: 'r2',
        async uploadPdf(tmpPath) {
          fs.rmSync(tmpPath, { force: true });
          return forcedRef;
        },
        async readPdf() { return null; },
        async remove() { removeCalls += 1; return removeCalls >= 2; },
        async removeMany() { return new Set(); },
        publicUrl() { return null; },
      },
      audioFanout: {
        async checkSetup() { return { ok: false, checks: [] }; },
        infoForSession() { return { available: false, reason: 'subscription_inactive' }; },
        async subscribe() { throw new Error('not used'); },
      },
      wakeSlideCleanup() { wakeCalls += 1; },
    });

    const boundary = '----fluent-create-failure';
    const multipart = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="title"\r\n\r\nForced failure\r\n` +
        `--${boundary}\r\nContent-Disposition: form-data; name="targetLang"\r\n\r\nes\r\n` +
        `--${boundary}\r\nContent-Disposition: form-data; name="slideType"\r\n\r\npdf\r\n` +
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="deck.pdf"\r\n` +
        `Content-Type: application/pdf\r\n\r\n`
      ),
      Buffer.from(MINI_PDF),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: {
        authorization: `Bearer ${SECRET}`,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload: multipart,
    });
    const queued = openDb
      .prepare('SELECT COUNT(*) AS count FROM pending_slide_deletions WHERE slide_ref = ?')
      .get(forcedRef).count;
    check(
      'failed DB insert queues uploaded deck when immediate removal fails',
      response.statusCode === 500 && queued === 1 && removeCalls === 1 && wakeCalls === 1,
      JSON.stringify({ status: response.statusCode, queued, removeCalls, wakeCalls })
    );

    openDb.exec(`
      DROP TRIGGER force_session_insert_failure;
      DELETE FROM pending_slide_deletions WHERE slide_ref = '${forcedRef}';
      CREATE TRIGGER force_cleanup_queue_failure
      BEFORE INSERT ON pending_slide_deletions
      BEGIN
        SELECT RAISE(ABORT, 'forced cleanup queue failure');
      END;
    `);
    const queueFailureResponse = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: {
        authorization: `Bearer ${SECRET}`,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload: multipart,
    });
    check(
      'failed durable queue write still attempts immediate uploaded-deck removal',
      queueFailureResponse.statusCode === 500 && removeCalls === 2,
      JSON.stringify({ status: queueFailureResponse.statusCode, removeCalls })
    );
  } finally {
    await app.close();
    openDb?.close();
    fs.rmSync(createFailureDir, { recursive: true, force: true });
  }
}

// ---- Test 0d: durable cleanup retries serialize and recheck attachment.
console.log('\n[0d] Serialized durable cleanup worker');
{
  const {
    initDb,
    queuePendingSlideDeletion,
  } = await import(path.join(ROOT, 'server/dist/db.js'));
  const { SlideCleanupWorker } = await import(path.join(ROOT, 'server/dist/slide-cleanup-worker.js'));
  const workerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluent-cleanup-worker-'));
  let workerDb = null;
  let active = 0;
  let maxActive = 0;
  let attempts = 0;
  const logs = [];
  try {
    workerDb = initDb(path.join(workerDir, 'app.db')).database;
    queuePendingSlideDeletion('hhhhhhhhhhhh.pdf');
    const worker = new SlideCleanupWorker({
      mode: 'local',
      async uploadPdf() { throw new Error('not used'); },
      async readPdf() { return null; },
      async remove() { return false; },
      async removeMany(refs) {
        attempts += 1;
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 20));
        active -= 1;
        return attempts === 1 ? new Set() : new Set(refs);
      },
      publicUrl() { return null; },
    }, {
      info(value) { logs.push(value); },
      warn(value) { logs.push(value); },
    }, 20);
    worker.start();
    worker.wake();
    worker.wake();
    const retried = await waitUntil(
      () => workerDb.prepare('SELECT COUNT(*) AS count FROM pending_slide_deletions').get().count === 0,
      1500
    );
    await worker.stop();
    const attemptsAfterStop = attempts;
    await new Promise((resolve) => setTimeout(resolve, 60));
    check(
      'cleanup worker serializes wakeups and clears a first-failure on retry',
      retried && attempts >= 2 && maxActive === 1 && attempts === attemptsAfterStop,
      JSON.stringify({ retried, attempts, maxActive, logs })
    );

    queuePendingSlideDeletion('iiiiiiiiiiii.pdf');
    workerDb.prepare(
      `INSERT INTO sessions (slug, title, target_lang, slide_type, slide_ref, presentation_mode)
       VALUES ('attached-during-cleanup', 'Attached', 'es', 'pdf', 'iiiiiiiiiiii.pdf', 'in_person')`
    ).run();
    let unsafeDeletes = 0;
    const referenceWorker = new SlideCleanupWorker({
      mode: 'local',
      async uploadPdf() { throw new Error('not used'); },
      async readPdf() { return null; },
      async remove() { return false; },
      async removeMany() { unsafeDeletes += 1; return new Set(); },
      publicUrl() { return null; },
    }, { info() {}, warn() {} }, 20);
    referenceWorker.start();
    const staleQueueCleared = await waitUntil(
      () => workerDb.prepare('SELECT COUNT(*) AS count FROM pending_slide_deletions').get().count === 0,
      500
    );
    await referenceWorker.stop();
    check(
      'cleanup worker rechecks references before touching storage',
      staleQueueCleared && unsafeDeletes === 0,
      JSON.stringify({ staleQueueCleared, unsafeDeletes })
    );
  } finally {
    workerDb?.close();
    fs.rmSync(workerDir, { recursive: true, force: true });
  }
}

// ---- Test 1: boots without ADMIN_SECRET, falling back to "admin" + warning
console.log('\n[1] Boot with no ADMIN_SECRET (defaults to "admin")');
{
  const noSecretEnv = { ...env, PORT: String(PORT) };
  delete noSecretEnv.ADMIN_SECRET;
  // cwd outside the repo so the server doesn't auto-load the project's .env
  const { tmpdir } = await import('node:os');
  const proc = spawn('node', [path.join(ROOT, 'server/dist/index.js')], {
    cwd: tmpdir(),
    env: noSecretEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  proc.stderr.on('data', (d) => (stderr += d));
  const ready = await waitForHealth();
  check('server boots without ADMIN_SECRET', ready, stderr);
  check('warns about the default secret', stderr.includes('ADMIN_SECRET'));
  if (ready) {
    const ok = await fetch(`${BASE}/api/auth/check`, {
      method: 'POST',
      headers: { Authorization: 'Bearer admin' },
    });
    check('default secret "admin" authenticates', ok.status === 200, `(got ${ok.status})`);
  } else {
    check('default secret "admin" authenticates', false, 'server did not start');
  }
  await stopProcess(proc);
}

// ---- Test 2: production refuses placeholder/missing ADMIN_SECRET
console.log('\n[2] Production ADMIN_SECRET validation');
{
  const prodEnv = { ...env, NODE_ENV: 'production' };
  delete prodEnv.ADMIN_SECRET;
  const { tmpdir } = await import('node:os');
  const proc = spawn('node', [path.join(ROOT, 'server/dist/index.js')], {
    cwd: tmpdir(),
    env: prodEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  proc.stderr.on('data', (d) => (stderr += d));
  const code = await new Promise((r) => proc.on('exit', r));
  check('production boot fails without ADMIN_SECRET', code !== 0 && stderr.includes('ADMIN_SECRET'), `(code ${code})`);
}

// ---- Test 3: production refuses weak ADMIN_SECRET
console.log('\n[3] Production ADMIN_SECRET strength validation');
{
  const prodEnv = { ...env, NODE_ENV: 'production', ADMIN_SECRET: 'too-short' };
  const { tmpdir } = await import('node:os');
  const proc = spawn('node', [path.join(ROOT, 'server/dist/index.js')], {
    cwd: tmpdir(),
    env: prodEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  proc.stderr.on('data', (d) => (stderr += d));
  const code = await new Promise((r) => proc.on('exit', r));
  check('production boot fails with short ADMIN_SECRET', code !== 0 && stderr.includes('ADMIN_SECRET'), `(code ${code})`);
}

// ---- Test 4: production refuses missing GEMINI_API_KEY
console.log('\n[4] Production GEMINI_API_KEY validation');
{
  const prodEnv = { ...env, NODE_ENV: 'production', ADMIN_SECRET: SECRET };
  delete prodEnv.GEMINI_API_KEY;
  const { tmpdir } = await import('node:os');
  const proc = spawn('node', [path.join(ROOT, 'server/dist/index.js')], {
    cwd: tmpdir(),
    env: prodEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  proc.stderr.on('data', (d) => (stderr += d));
  const code = await new Promise((r) => proc.on('exit', r));
  check('production boot fails without GEMINI_API_KEY', code !== 0 && stderr.includes('GEMINI_API_KEY'), `(code ${code})`);
}

// ---- Test 5: invalid numeric env validation
console.log('\n[5] Numeric environment validation');
{
  const badPortEnv = { ...env, PORT: 'not-a-port' };
  const { tmpdir } = await import('node:os');
  const proc = spawn('node', [path.join(ROOT, 'server/dist/index.js')], {
    cwd: tmpdir(),
    env: badPortEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  proc.stderr.on('data', (d) => (stderr += d));
  const code = await new Promise((r) => proc.on('exit', r));
  check('boot fails with invalid PORT', code !== 0 && stderr.includes('PORT'), `(code ${code})`);
}
{
  const unsafePublicR2Env = {
    ...env,
    R2_PUBLIC_BASE_URL: 'https://cdn.example.com',
    R2_CACHE_PURGE_ZONE_ID: '',
    R2_CACHE_PURGE_API_TOKEN: '',
  };
  const { tmpdir } = await import('node:os');
  const proc = spawn('node', [path.join(ROOT, 'server/dist/index.js')], {
    cwd: tmpdir(),
    env: unsafePublicR2Env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  proc.stderr.on('data', (d) => (stderr += d));
  const code = await new Promise((r) => proc.on('exit', r));
  check(
    'public R2 delivery requires cache-purge credentials',
    code !== 0 && stderr.includes('R2_CACHE_PURGE'),
    `(code ${code})`
  );
}
{
  const assetOnly = startServer({
    ASSET_CDN_BASE_URL: 'https://assets.example.test',
    R2_PUBLIC_BASE_URL: '',
    R2_CACHE_PURGE_BASE_URLS: '',
    R2_CACHE_PURGE_ZONE_ID: '',
    R2_CACHE_PURGE_API_TOKEN: '',
  });
  let stderr = '';
  assetOnly.stderr.on('data', (data) => (stderr += data));
  const ready = await waitForHealth();
  check(
    'asset-only CDN does not require slide cache-purge credentials',
    ready,
    stderr
  );
  await stopProcess(assetOnly);
}

// ---- Test 6: secrets absent from client bundle (criterion #6)
console.log('\n[6] No secrets in client bundle');
{
  const serverOnlyEnvNames = [
    'ADMIN_SECRET',
    'GEMINI_API_KEY',
    'DATABASE_PATH',
    'UPLOADS_DIR',
    'PORT',
    'HOST',
    'PUBLIC_ORIGIN',
    'TRUST_PROXY',
    'MAX_VIEWERS_PER_SESSION',
    'PUBLIC_GET_MAX',
    'SENTRY_DSN',
    'ENABLE_TEST_HOOKS',
    'AUDIO_SYNC_METADATA',
    'AUDIO_SUBSCRIPTION_ACTIVE',
    'CF_REALTIME_APP_ID',
    'CF_REALTIME_APP_SECRET',
    'CF_REALTIME_APP_TOKEN',
    'CF_REALTIME_API_BASE',
    'R2_ACCOUNT_ID',
    'R2_ACCESS_KEY_ID',
    'R2_SECRET_ACCESS_KEY',
    'R2_BUCKET',
    'R2_PUBLIC_BASE_URL',
    'R2_CACHE_PURGE_BASE_URLS',
    'R2_CACHE_PURGE_ZONE_ID',
    'R2_CACHE_PURGE_API_TOKEN',
    'ASSET_CDN_BASE_URL',
  ];
  const fakeServerSecrets = [SECRET, env.GEMINI_API_KEY, 'fake-realtime-secret', 'app-test'];
  const needles = [...serverOnlyEnvNames, ...fakeServerSecrets];
  const hits = [];
  const dist = path.join(ROOT, 'client', 'dist');
  const pending = [dist];
  while (pending.length > 0) {
    const entry = pending.pop();
    const stat = fs.statSync(entry);
    if (stat.isDirectory()) {
      for (const child of fs.readdirSync(entry)) pending.push(path.join(entry, child));
      continue;
    }
    const data = fs.readFileSync(entry);
    for (const needle of needles) {
      if (data.includes(Buffer.from(needle))) {
        hits.push(`${path.relative(dist, entry)} contains ${needle}`);
      }
    }
  }
  check(
    'client/dist excludes server-only env names and fake server secret values',
    hits.length === 0,
    hits.join('\n')
  );
}

// ---- Boot the real server
console.log('\n[7] HTTP auth (criterion #7)');
{
  const maintenanceDb = new Database(env.DATABASE_PATH);
  maintenanceDb
    .prepare('INSERT OR IGNORE INTO pending_slide_deletions (slide_ref) VALUES (?)')
    .run('r2:slides/eeeeeeeeeeee.pdf');
  maintenanceDb.close();
}
const server = startServer();
server.stderr.on('data', (d) => process.env.SMOKE_DEBUG && console.error(String(d)));
if (!(await waitForHealth())) {
  console.error('server failed to start');
  process.exit(1);
}

{
  const health = await fetch(`${BASE}/healthz`);
  const csp = health.headers.get('content-security-policy') ?? '';
  const scriptSrc = csp.match(/script-src[^;]*/)?.[0] ?? '';
  const healthBody = await health.json().catch(() => null);
  check(
    'security headers include CSP + nosniff and block inline scripts',
    csp.includes("default-src 'self'") &&
      !scriptSrc.includes("'unsafe-inline'") &&
      health.headers.get('x-content-type-options') === 'nosniff',
    csp
  );
  check(
    'healthz reports degraded maintenance without exposing queued refs',
    health.ok &&
      healthBody?.ok === true &&
      healthBody?.maintenance?.status === 'degraded' &&
      healthBody?.maintenance?.pendingSlideDeletions === 1 &&
      healthBody?.maintenance?.compactionPending === false &&
      !JSON.stringify(healthBody).includes('eeeeeeeeeeee'),
    JSON.stringify(healthBody)
  );
  await new Promise((resolve) => setTimeout(resolve, 150));
  const maintenanceDb = new Database(env.DATABASE_PATH);
  const pendingAfterBoot = maintenanceDb
    .prepare('SELECT COUNT(*) AS count FROM pending_slide_deletions WHERE slide_ref = ?')
    .get('r2:slides/eeeeeeeeeeee.pdf').count;
  maintenanceDb
    .prepare('DELETE FROM pending_slide_deletions WHERE slide_ref = ?')
    .run('r2:slides/eeeeeeeeeeee.pdf');
  maintenanceDb.close();
  check(
    'failed pending deck cleanup does not block health and remains durable',
    health.ok && pendingAfterBoot === 1
  );
  const healthyMaintenance = await (await fetch(`${BASE}/healthz`)).json();
  check(
    'healthz clears its degraded maintenance signal when queues are empty',
    healthyMaintenance?.maintenance?.status === 'ok' &&
      healthyMaintenance?.maintenance?.pendingSlideDeletions === 0 &&
      healthyMaintenance?.maintenance?.compactionPending === false,
    JSON.stringify(healthyMaintenance)
  );

  const retiredEndpoints = await Promise.all([
    fetch(`${BASE}/api/try`, { method: 'POST' }),
    fetch(`${BASE}/api/beta/trial`, { method: 'POST' }),
    fetch(`${BASE}/api/beta/leads`),
    fetch(`${BASE}/api/beta/trial/retired/expedite`, { method: 'POST' }),
    fetch(`${BASE}/api/beta/trial/retired/feedback`, { method: 'POST' }),
  ]);
  check(
    'all retired public-session and lead endpoints are unavailable',
    retiredEndpoints.every((response) => response.status === 404),
    `(got ${retiredEndpoints.map((response) => response.status).join(', ')})`
  );

  // wrong key → 401
  const res = await fetch(`${BASE}/api/sessions`, {
    method: 'POST',
    headers: { Authorization: 'Bearer wrong-key', 'Content-Type': 'application/json' },
    body: '{}',
  });
  check('wrong admin key on /api/sessions returns 401', res.status === 401, `(got ${res.status})`);

  // repeated failures → 429
  let last = 0;
  for (let i = 0; i < 6; i++) {
    const r = await fetch(`${BASE}/api/auth/check`, {
      method: 'POST',
      headers: { Authorization: 'Bearer wrong-key', 'X-Forwarded-For': `203.0.113.${i + 1}` },
    });
    last = r.status;
  }
  check('repeated failures are rate-limited even with spoofed XFF (429)', last === 429, `(got ${last})`);
}

// Rate limit window is per-IP and we just burned it; restart to clear state.
await stopProcess(server);
const server2 = startServer();
await waitForHealth();

// ---- Test 8: create a session with a PDF (criterion #1, server side)
console.log('\n[8] Session creation with PDF upload');
let slug = '';
let speakerSlug = '';
{
  const form = new FormData();
  form.set('title', 'Smoke Talk');
  form.set('targetLang', 'es');
  form.set('slideType', 'pdf');
  form.set('file', new File([MINI_PDF], 'deck.pdf', { type: 'application/pdf' }));
  const res = await fetch(`${BASE}/api/sessions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${SECRET}` },
    body: form,
  });
  const body = await res.json();
  slug = body.slug ?? '';
  check('create returns slug + paths', res.ok && slug.length === 8 && body.viewerPath === `/${slug}`, JSON.stringify(body));

  const info = await (await fetch(`${BASE}/api/sessions/${slug}`)).json();
  check(
    'public session info has es/pdf and no secrets',
      info.targetLang === 'es' &&
      info.slideType === 'pdf' &&
      !Object.hasOwn(info, 'resources') &&
      !Object.hasOwn(info, 'trialKind') &&
      !Object.hasOwn(info, 'trialRuntimeMs') &&
      !Object.hasOwn(info, 'trialMaxViewers') &&
      !Object.hasOwn(info, 'hostToken') &&
      !JSON.stringify(info).includes(SECRET)
  );
  check(
    'public session info marks audio unavailable when the operator gate is off',
    info.audio?.available === false && info.audio?.reason === 'subscription_inactive',
    JSON.stringify(info.audio)
  );
  const retiredTokenAnalytics = await fetch(`${BASE}/api/sessions/${slug}/analytics`, {
    headers: { Authorization: 'Bearer retired-session-host-token' },
  });
  check(
    'retired per-session host tokens cannot authorize analytics',
    retiredTokenAnalytics.status === 401,
    `(got ${retiredTokenAnalytics.status})`
  );

  const deleteFixtureDb = new Database(env.DATABASE_PATH);
  deleteFixtureDb.prepare(
    `INSERT INTO sessions (slug, title, target_lang, slide_type, slide_ref, presentation_mode)
     VALUES (?, ?, 'es', 'pdf', ?, 'in_person')`
  ).run('shared-delete-a', 'Shared delete A', 'ssssssssssss.pdf');
  deleteFixtureDb.prepare(
    `INSERT INTO sessions (slug, title, target_lang, slide_type, slide_ref, presentation_mode)
     VALUES (?, ?, 'es', 'pdf', ?, 'in_person')`
  ).run('shared-delete-b', 'Shared delete B', 'ssssssssssss.pdf');
  deleteFixtureDb.prepare(
    `INSERT INTO sessions (slug, title, target_lang, slide_type, slide_ref, presentation_mode)
     VALUES (?, ?, 'es', 'pdf', ?, 'in_person')`
  ).run('failed-r2-delete', 'Failed R2 delete', 'r2:slides/ffffffffffff.pdf');
  deleteFixtureDb.close();

  const sharedDelete = await fetch(`${BASE}/api/sessions/shared-delete-a`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${SECRET}` },
  });
  const sharedDeleteBody = await sharedDelete.json();
  check(
    'DELETE returns 200 when a shared deck must be retained',
    sharedDelete.status === 200 && sharedDeleteBody.cleanupPending === false,
    `(status ${sharedDelete.status}, body ${JSON.stringify(sharedDeleteBody)})`
  );

  const failedStorageDelete = await fetch(`${BASE}/api/sessions/failed-r2-delete`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${SECRET}` },
  });
  const failedStorageDeleteBody = await failedStorageDelete.json();
  await new Promise((resolve) => setTimeout(resolve, 100));
  const deletedInfo = await fetch(`${BASE}/api/sessions/failed-r2-delete`);
  const queuedDeleteDb = new Database(env.DATABASE_PATH);
  const failedDeleteQueued = queuedDeleteDb
    .prepare('SELECT COUNT(*) AS count FROM pending_slide_deletions WHERE slide_ref = ?')
    .get('r2:slides/ffffffffffff.pdf').count;
  queuedDeleteDb.prepare('DELETE FROM sessions WHERE slug = ?').run('shared-delete-b');
  queuedDeleteDb
    .prepare('DELETE FROM pending_slide_deletions WHERE slide_ref = ?')
    .run('r2:slides/ffffffffffff.pdf');
  queuedDeleteDb.close();
  check(
    'DELETE returns 202 after DB success when deck cleanup must retry',
    failedStorageDelete.status === 202 &&
      failedStorageDeleteBody.cleanupPending === true &&
      deletedInfo.status === 404 &&
      failedDeleteQueued === 1,
    `(status ${failedStorageDelete.status}, body ${JSON.stringify(failedStorageDeleteBody)}, queued ${failedDeleteQueued})`
  );
  const audioSub = await fetch(`${BASE}/api/sessions/${slug}/audio/subscribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionDescription: { type: 'offer', sdp: 'v=0\r\n' } }),
  });
  const audioSubBody = await audioSub.json();
  check(
    'audio subscribe is gated with 403 when subscription is inactive',
    audioSub.status === 403 && audioSubBody.code === 'audio_subscription_inactive',
    `(status ${audioSub.status}, body ${JSON.stringify(audioSubBody)})`
  );
  const sfuUnauthorized = await fetch(`${BASE}/api/admin/audio/sfu/check`, {
    method: 'POST',
    headers: { Authorization: 'Bearer wrong-key' },
  });
  check('SFU diagnostic requires admin auth', sfuUnauthorized.status === 401, `(status ${sfuUnauthorized.status})`);
  const inactiveSfu = await fetch(`${BASE}/api/admin/audio/sfu/check`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${SECRET}` },
  });
  const inactiveSfuBody = await inactiveSfu.json();
  check(
    'SFU diagnostic reports inactive gate without external calls',
    inactiveSfu.ok &&
      inactiveSfuBody.ok === false &&
      inactiveSfuBody.checks?.[0]?.name === 'env' &&
      inactiveSfuBody.checks?.[0]?.code === 'audio_subscription_inactive' &&
      !JSON.stringify(inactiveSfuBody).includes(SECRET),
    JSON.stringify(inactiveSfuBody)
  );
  const pdf = await fetch(`${BASE}${info.slideUrl}`);
  check(
    'uploaded PDF is served without cache retention',
    pdf.ok &&
      pdf.headers.get('cache-control')?.includes('no-store') &&
      (await pdf.text()).startsWith('%PDF')
  );
  const langs = await (await fetch(`${BASE}/api/languages`)).json();
  check('language table has 70+ entries', Array.isArray(langs) && langs.length >= 70, `(got ${langs.length})`);

  const speakerOnlyRes = await fetch(`${BASE}/api/sessions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: 'Speaker-only Stage',
      targetLang: 'es',
      // The server owns this invariant: a client cannot create a remote
      // speaker-only session even if it submits contradictory JSON directly.
      presentationMode: 'remote',
      audienceEnabled: false,
      slideType: 'html',
      slideUrl: 'https://example.com/speaker-stage.html',
    }),
  });
  const speakerOnlyBody = await speakerOnlyRes.json();
  speakerSlug = speakerOnlyBody.slug ?? '';
  const speakerOnlyInfoRes = await fetch(`${BASE}/api/sessions/${speakerSlug}`, {
    headers: { Authorization: `Bearer ${SECRET}` },
  });
  const speakerOnlyInfo = await speakerOnlyInfoRes.json();
  check(
    'speaker-only creation persists disabled audience delivery',
    speakerOnlyRes.ok &&
      speakerOnlyBody.audienceEnabled === false &&
      speakerOnlyInfoRes.ok &&
      speakerOnlyInfo.audienceEnabled === false &&
      speakerOnlyInfo.presentationMode === 'in_person',
    JSON.stringify({ body: speakerOnlyBody, info: speakerOnlyInfo })
  );
  const publicSpeakerInfo = await fetch(`${BASE}/api/sessions/${speakerSlug}`);
  const publicSpeakerInfoBody = await publicSpeakerInfo.json();
  const publicSpeakerTranscript = await fetch(`${BASE}/api/sessions/${speakerSlug}/transcript`);
  const publicSpeakerPolls = await fetch(`${BASE}/api/sessions/${speakerSlug}/polls`);
  check(
    'speaker-only public metadata is content-free and transcript/polls require operator auth',
    publicSpeakerInfo.ok &&
      publicSpeakerInfoBody.audienceEnabled === false &&
      publicSpeakerInfoBody.title === 'Speaker-only session' &&
      publicSpeakerInfoBody.slideUrl === '' &&
      publicSpeakerTranscript.status === 403 &&
      publicSpeakerPolls.status === 403,
    JSON.stringify({
      info: publicSpeakerInfo.status,
      transcript: publicSpeakerTranscript.status,
      polls: publicSpeakerPolls.status,
      body: publicSpeakerInfoBody,
    })
  );
  check(
    'speaker-only session reports no audience audio transport',
    speakerOnlyInfo.audio?.available === false &&
      speakerOnlyInfo.audio?.transport === 'none' &&
      speakerOnlyInfo.audio?.reason === 'audience_disabled',
    JSON.stringify(speakerOnlyInfo.audio)
  );
  const speakerAudioSub = await fetch(`${BASE}/api/sessions/${speakerSlug}/audio/subscribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionDescription: { type: 'offer', sdp: 'v=0\r\n' } }),
  });
  const speakerAudioSubBody = await speakerAudioSub.json();
  check(
    'speaker-only session rejects audience audio subscription',
    speakerAudioSub.status === 403 && speakerAudioSubBody.code === 'audience_disabled',
    `(status ${speakerAudioSub.status}, body ${JSON.stringify(speakerAudioSubBody)})`
  );
  const sessionsList = await (
    await fetch(`${BASE}/api/sessions`, { headers: { Authorization: `Bearer ${SECRET}` } })
  ).json();
  check(
    'admin session list identifies speaker-only sessions',
    sessionsList.find((session) => session.slug === speakerSlug)?.audienceEnabled === false,
    JSON.stringify(sessionsList.find((session) => session.slug === speakerSlug))
  );

  const htmlUpload = new FormData();
  htmlUpload.set('title', 'Bad HTML Upload');
  htmlUpload.set('targetLang', 'es');
  htmlUpload.set('slideType', 'html');
  htmlUpload.set('file', new File(['<script>top.location="/admin"</script>'], 'deck.html', { type: 'text/html' }));
  const htmlUploadRes = await fetch(`${BASE}/api/sessions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${SECRET}` },
    body: htmlUpload,
  });
  check('HTML file uploads are rejected', htmlUploadRes.status === 400, `(got ${htmlUploadRes.status})`);

  const uploadsBeforeFakePdf = fs.existsSync(env.UPLOADS_DIR)
    ? fs.readdirSync(env.UPLOADS_DIR).sort().join('|')
    : '';
  const fakePdf = new FormData();
  fakePdf.set('title', 'Fake PDF');
  fakePdf.set('targetLang', 'es');
  fakePdf.set('slideType', 'pdf');
  fakePdf.set('file', new File(['<html>not a pdf</html>'], 'fake.pdf', { type: 'application/pdf' }));
  const fakePdfRes = await fetch(`${BASE}/api/sessions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${SECRET}` },
    body: fakePdf,
  });
  const uploadsAfterFakePdf = fs.existsSync(env.UPLOADS_DIR)
    ? fs.readdirSync(env.UPLOADS_DIR).sort().join('|')
    : '';
  check('fake .pdf upload is rejected and cleaned up', fakePdfRes.status === 400 && uploadsAfterFakePdf === uploadsBeforeFakePdf);

  const uploadsBeforeBadPdfStructure = fs.existsSync(env.UPLOADS_DIR)
    ? fs.readdirSync(env.UPLOADS_DIR).sort().join('|')
    : '';
  const badPdfStructure = new FormData();
  badPdfStructure.set('title', 'Bad PDF Structure');
  badPdfStructure.set('targetLang', 'es');
  badPdfStructure.set('slideType', 'pdf');
  badPdfStructure.set('file', new File(['%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n'], 'bad-structure.pdf', { type: 'application/pdf' }));
  const badPdfStructureRes = await fetch(`${BASE}/api/sessions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${SECRET}` },
    body: badPdfStructure,
  });
  const uploadsAfterBadPdfStructure = fs.existsSync(env.UPLOADS_DIR)
    ? fs.readdirSync(env.UPLOADS_DIR).sort().join('|')
    : '';
  check(
    'malformed PDF structure is rejected and cleaned up',
    badPdfStructureRes.status === 400 && uploadsAfterBadPdfStructure === uploadsBeforeBadPdfStructure,
    `(got ${badPdfStructureRes.status})`
  );

  const externalHtml = new FormData();
  externalHtml.set('title', 'External HTML Deck');
  externalHtml.set('targetLang', 'es');
  externalHtml.set('slideType', 'html');
  externalHtml.set('slideUrl', 'https://example.com/deck.html');
  const externalHtmlRes = await fetch(`${BASE}/api/sessions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${SECRET}` },
    body: externalHtml,
  });
  const externalHtmlBody = await externalHtmlRes.json();
  const externalHtmlInfo = await (await fetch(`${BASE}/api/sessions/${externalHtmlBody.slug}`)).json();
  check('external HTML deck URL is accepted', externalHtmlRes.ok && externalHtmlInfo.slideUrl === 'https://example.com/deck.html');
  const externalHtmlDelete = await fetch(`${BASE}/api/sessions/${externalHtmlBody.slug}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${SECRET}` },
  });
  const externalHtmlDeleteBody = await externalHtmlDelete.json();
  check(
    'DELETE returns 200 when an external deck needs no storage cleanup',
    externalHtmlDelete.status === 200 && externalHtmlDeleteBody.cleanupPending === false,
    `(status ${externalHtmlDelete.status}, body ${JSON.stringify(externalHtmlDeleteBody)})`
  );

  const sameOriginHtml = new FormData();
  sameOriginHtml.set('title', 'Same Origin HTML Deck');
  sameOriginHtml.set('targetLang', 'es');
  sameOriginHtml.set('slideType', 'html');
  sameOriginHtml.set('slideUrl', `${BASE}/deck.html`);
  const sameOriginHtmlRes = await fetch(`${BASE}/api/sessions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${SECRET}` },
    body: sameOriginHtml,
  });
  check('same-origin HTML deck URL is rejected from request Host', sameOriginHtmlRes.status === 400, `(got ${sameOriginHtmlRes.status})`);

  const uploadsBeforeBadSlideCount = fs.existsSync(env.UPLOADS_DIR)
    ? fs.readdirSync(env.UPLOADS_DIR).sort().join('|')
    : '';
  const badSlideCount = new FormData();
  badSlideCount.set('title', 'Bad Slide Count');
  badSlideCount.set('targetLang', 'es');
  badSlideCount.set('slideType', 'pdf');
  badSlideCount.set('slideCount', 'not-a-number');
  badSlideCount.set('file', new File([MINI_PDF], 'bad-count.pdf', { type: 'application/pdf' }));
  const badSlideCountRes = await fetch(`${BASE}/api/sessions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${SECRET}` },
    body: badSlideCount,
  });
  const uploadsAfterBadSlideCount = fs.existsSync(env.UPLOADS_DIR)
    ? fs.readdirSync(env.UPLOADS_DIR).sort().join('|')
    : '';
  check('invalid slideCount is rejected and upload is cleaned up', badSlideCountRes.status === 400 && uploadsAfterBadSlideCount === uploadsBeforeBadSlideCount);

}

// ---- Test 9: WS auth + read-only viewers (criterion #7)
console.log('\n[9] WebSocket roles');
{
  const speakerViewer = await wsOpen(speakerSlug, { role: 'viewer', viewerId: 'not-admitted' });
  check(
    'speaker-only session rejects viewer sockets',
    speakerViewer.closeCode() === 4403,
    `(close ${speakerViewer.closeCode()})`
  );
  const speakerHost = await wsOpen(speakerSlug, { role: 'host', auth: SECRET });
  check(
    'speaker-only host still receives a room snapshot',
    speakerHost.messages.some((message) => message.type === 'snapshot')
  );
  speakerHost.ws.send(JSON.stringify({
    type: 'poll.open',
    ts: 0,
    seq: 0,
    payload: { question: 'This must not persist', options: ['A', 'B'] },
  }));
  await new Promise((r) => setTimeout(r, 200));
  const speakerPollsRes = await fetch(`${BASE}/api/sessions/${speakerSlug}/polls`, {
    headers: { Authorization: `Bearer ${SECRET}` },
  });
  const speakerPollsBody = await speakerPollsRes.json();
  check(
    'speaker-only host poll commands are rejected without persistence',
    speakerHost.messages.some(
      (message) => message.type === 'error' && message.payload?.code === 'audience_disabled'
    ) && speakerPollsBody.polls?.length === 0,
    JSON.stringify({ messages: speakerHost.messages, polls: speakerPollsBody })
  );
  speakerViewer.ws.close();
  speakerHost.ws.close();

  const viewer = await wsOpen(slug, { role: 'viewer' });
  const snap = viewer.messages.find((m) => m.type === 'snapshot');
  check(
    'viewer receives an authoritative read-only snapshot',
    !!snap && snap.payload.state === 'created' && snap.payload.slideIndex === 0 && snap.payload.canPresent === false
  );

  const rejectedPresenter = await wsOpen(slug, { role: 'viewer', auth: 'wrong-presenter-key' });
  const rejectedPresenterSnap = rejectedPresenter.messages.find((m) => m.type === 'snapshot');
  check(
    'invalid presenter key stays connected but is authoritatively read-only',
    rejectedPresenterSnap?.payload.canPresent === false && rejectedPresenter.closeCode() === null
  );
  rejectedPresenter.ws.close();

  viewer.ws.send(JSON.stringify({ type: 'slide.change', ts: 0, seq: 0, payload: { index: 5 } }));
  await new Promise((r) => setTimeout(r, 500));
  check('viewer publishing slide.change is rejected + closed', viewer.closeCode() === 4403, `(close ${viewer.closeCode()})`);

  const badHost = await wsOpen(slug, { role: 'host', auth: 'wrong-secret' });
  check('host with wrong secret is rejected (4401)', badHost.closeCode() === 4401, `(close ${badHost.closeCode()})`);

  const host = await wsOpen(slug, { role: 'host', auth: SECRET });
  check(
    'host with correct secret gets presenter capability',
    host.messages.some((m) => m.type === 'snapshot' && m.payload.canPresent === true)
  );

  const removedResourceRole = await wsOpen(slug, { role: 'resource' });
  check('removed resource role is rejected', removedResourceRole.closeCode() === 4403, `(close ${removedResourceRole.closeCode()})`);

  // host changes slide → late-joining viewer lands on it (criterion #3, late join)
  const viewer2 = await wsOpen(slug, { role: 'viewer' });
  const presenter = await wsOpen(slug, { role: 'viewer', auth: SECRET });
  const presenterSnap = presenter.messages.find((m) => m.type === 'snapshot');
  check('valid presenter key receives server-granted controls', presenterSnap?.payload.canPresent === true);
  presenter.ws.send(JSON.stringify({ type: 'slide.change', ts: 0, seq: 0, payload: { index: 1 } }));
  await new Promise((r) => setTimeout(r, 200));
  check(
    'authenticated presenter can change slides',
    viewer2.messages.some((m) => m.type === 'slide.change' && m.payload.index === 1)
  );
  host.ws.send(JSON.stringify({
    type: 'poll.open',
    ts: 0,
    seq: 0,
    payload: { question: 'Ready for the next slide?', options: ['Yes', 'No'] },
  }));
  host.ws.send(JSON.stringify({ type: 'slide.change', ts: 0, seq: 0, payload: { index: 2 } }));
  await new Promise((r) => setTimeout(r, 400));
  const hostSlideReceived = viewer2.messages.some(
    (m) => m.type === 'slide.change' && m.payload.index === 2
  );
  check('viewer receives slide.change from host', hostSlideReceived);
  const lateViewer = await wsOpen(slug, { role: 'viewer' });
  const lateSnap = lateViewer.messages.find((m) => m.type === 'snapshot');
  check('late joiner lands on slide 3 (index 2)', lateSnap?.payload.slideIndex === 2);

  const presence = host.messages.find((m) => m.type === 'presence');
  check('host receives presence (viewer count)', !!presence);

  host.ws.close();
  presenter.ws.close();
  viewer2.ws.close();
  lateViewer.ws.close();

  // An oversized/malformed audio frame must be DROPPED, not close the session —
  // a hard close here is what made the client reconnect-loop on Start.
  const audioHost = await wsOpen(slug, { role: 'host', auth: SECRET });
  audioHost.ws.send(JSON.stringify({ type: 'audio.in', ts: 0, seq: 0, payload: { data: 'A'.repeat(64004) } }));
  await new Promise((r) => setTimeout(r, 300));
  check('oversized audio.in frame is dropped, socket stays open', audioHost.closeCode() === null, `(close ${audioHost.closeCode()})`);
  // A valid frame after the bad one is still accepted (session not torn down).
  audioHost.ws.send(JSON.stringify({ type: 'audio.in', ts: 0, seq: 0, payload: { data: 'AAAA'.repeat(100) } }));
  await new Promise((r) => setTimeout(r, 300));
  check('host socket survives a bad frame and keeps streaming', audioHost.closeCode() === null, `(close ${audioHost.closeCode()})`);
  audioHost.ws.close();
  await new Promise((r) => setTimeout(r, 300));

  // One presenter failure was recorded above. Reach its independent
  // five-failure boundary, then prove invalid attempts are rejected while a
  // correct venue key still succeeds and the Host budget remains separate.
  for (let i = 0; i < 4; i++) {
    const invalidStage = await wsOpen(slug, { role: 'viewer', auth: `wrong-stage-key-${i}` });
    invalidStage.ws.close();
  }
  const limitedStage = await wsOpen(slug, { role: 'viewer', auth: 'wrong-stage-key-limited' });
  check(
    'invalid presenter credentials use the presenter per-IP auth rate limit',
    limitedStage.closeCode() === 4429,
    `(close ${limitedStage.closeCode()})`
  );
  const validStageAfterFailures = await wsOpen(slug, { role: 'viewer', auth: SECRET });
  check(
    'a correct presenter key bypasses another attendee\'s failed-key budget',
    validStageAfterFailures.messages.some(
      (message) => message.type === 'snapshot' && message.payload.canPresent === true
    )
  );
  validStageAfterFailures.ws.close();
  const hostBudgetIsolated = await wsOpen(slug, { role: 'host', auth: 'another-wrong-host-key' });
  check(
    'Host and presenter failed-auth budgets are isolated behind venue NAT',
    hostBudgetIsolated.closeCode() === 4401,
    `(close ${hostBudgetIsolated.closeCode()})`
  );
}

// ---- Test 9b: 500 audience control sockets do not receive app-WS audio payloads
console.log('\n[9b] 500-viewer control channel');
{
  const viewers = await Promise.all(
    Array.from({ length: 500 }, (_, i) =>
      wsOpen(slug, { role: 'viewer', viewerId: `load-${i}`, name: '', company: '' })
    )
  );
  const allConnected = viewers.every((v) => v.messages.some((m) => m.type === 'snapshot'));
  const noAudioOverAppWs = viewers.every((v) => !v.messages.some((m) => m.type === 'audio.out'));
  check('500 viewers receive snapshots', allConnected);
  check('500 viewers receive no audio.out over app WS', noAudioOverAppWs);
  viewers.forEach((v) => v.ws.close());
  await new Promise((r) => setTimeout(r, 300));
}

// ---- Test 10: persistence across restart (criterion #8)
console.log('\n[10] Restart persistence');
await stopProcess(server2);
const server3 = startServer();
await waitForHealth();
{
  const res = await fetch(`${BASE}/api/sessions/${slug}`);
  const info = await res.json();
  check(
    'session survives a server restart',
    res.ok && info.slug === slug && info.title === 'Smoke Talk',
    `(status ${res.status}, body ${JSON.stringify(info)}, slug ${slug})`
  );
  const speakerInfo = await (
    await fetch(`${BASE}/api/sessions/${speakerSlug}`, {
      headers: { Authorization: `Bearer ${SECRET}` },
    })
  ).json();
  check(
    'speaker-only delivery flag survives a server restart',
    speakerInfo.slug === speakerSlug && speakerInfo.audienceEnabled === false,
    JSON.stringify(speakerInfo)
  );
  const tr = await (await fetch(`${BASE}/api/sessions/${slug}/transcript`)).json();
  check('transcript endpoint is publicly readable', Array.isArray(tr.segments), JSON.stringify(tr));
}
await stopProcess(server3);

// ---- Test 10a: SFU setup diagnostic
console.log('\n[10a] Cloudflare SFU diagnostic');
{
  const missing = startServer({
    AUDIO_SUBSCRIPTION_ACTIVE: 'true',
    PUBLIC_ORIGIN: 'https://talk.example.test',
    CF_REALTIME_APP_ID: '',
    CF_REALTIME_APP_SECRET: '',
    CF_REALTIME_API_BASE: '',
  });
  if (!(await waitForHealth())) {
    console.error('SFU missing-config server failed to start');
    process.exit(1);
  }
  const res = await fetch(`${BASE}/api/admin/audio/sfu/check`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${SECRET}` },
  });
  const body = await res.json();
  check(
    'SFU diagnostic reports missing Cloudflare config without external calls',
    res.ok && body.ok === false && body.checks?.length === 1 && body.checks[0].code === 'not_configured',
    JSON.stringify(body)
  );
  await stopProcess(missing);
}
{
  const fake = await startFakeRealtime({ connectBack: true });
  const sfuServer = startServer({
    AUDIO_SUBSCRIPTION_ACTIVE: 'true',
    PUBLIC_ORIGIN: `https://127.0.0.1:${PORT}`,
    CF_REALTIME_APP_ID: 'app-test',
    CF_REALTIME_APP_SECRET: 'fake-realtime-secret',
    CF_REALTIME_API_BASE: fake.base,
  });
  if (!(await waitForHealth())) {
    console.error('SFU mocked server failed to start');
    process.exit(1);
  }
  const res = await fetch(`${BASE}/api/admin/audio/sfu/check`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ timeoutMs: 1_000 }),
  });
  const body = await res.json();
  const names = new Set(body.checks?.map((c) => c.name));
  const callPaths = fake.calls.map((c) => c.path);
  check(
    'SFU diagnostic succeeds with mocked Cloudflare callback',
    res.ok &&
      body.ok === true &&
      ['env', 'cloudflare_session', 'websocket_adapter', 'ingest_callback', 'cleanup'].every((name) =>
        names.has(name)
      ),
    JSON.stringify(body)
  );
  check(
    'SFU diagnostic creates and closes a WebSocket adapter',
    callPaths.some((p) => p.endsWith('/adapters/websocket/new')) &&
      callPaths.some((p) => p.endsWith('/adapters/websocket/close')),
    callPaths.join(',')
  );
  await stopProcess(sfuServer);
  await fake.close();
}
{
  const fake = await startFakeRealtime({ connectBack: false });
  const timeoutServer = startServer({
    AUDIO_SUBSCRIPTION_ACTIVE: 'true',
    PUBLIC_ORIGIN: `https://127.0.0.1:${PORT}`,
    CF_REALTIME_APP_ID: 'app-test',
    CF_REALTIME_APP_SECRET: 'fake-realtime-secret',
    CF_REALTIME_API_BASE: fake.base,
  });
  if (!(await waitForHealth())) {
    console.error('SFU timeout server failed to start');
    process.exit(1);
  }
  const res = await fetch(`${BASE}/api/admin/audio/sfu/check`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ timeoutMs: 500 }),
  });
  const body = await res.json();
  const ingest = body.checks?.find((c) => c.name === 'ingest_callback');
  const cleanup = body.checks?.find((c) => c.name === 'cleanup');
  check(
    'SFU diagnostic reports callback timeout and still cleans up',
    res.ok &&
      body.ok === false &&
      ingest?.ok === false &&
      ingest?.code === 'ingest_callback_timeout' &&
      cleanup?.ok === true,
    JSON.stringify(body)
  );
  await stopProcess(timeoutServer);
  await fake.close();
}
{
  const fake = await startFakeRealtime({ connectBack: false });
  const harness = await startAudioFanoutHarness(fake);
  const offer = { type: 'offer', sdp: 'v=0\r\n' };

  const first = await harness.fanout.subscribe('recover-smoke', offer);
  harness.fanout.publishTranslated('recover-smoke', makePcm24kToneBase64(1000));
  const queuedBefore = harness.fanout.queueDepthMs('recover-smoke');
  const second = await harness.fanout.subscribe('recover-smoke', offer, {
    recoverPublisher: true,
    publisherGeneration: first.publisherGeneration,
    reason: 'smoke recovery',
  });
  const queuedAfter = harness.fanout.queueDepthMs('recover-smoke');
  const adapterCreates = fake.calls.filter((c) => c.path.endsWith('/adapters/websocket/new'));
  const adapterCloses = fake.calls.filter((c) => c.path.endsWith('/adapters/websocket/close'));
  const trackSubs = fake.calls.filter((c) => /\/sessions\/[^/]+\/tracks\/new$/.test(c.path));
  const secondTrack = trackSubs[1]?.body?.tracks?.[0];

  check(
    'SFU publisher recovery increments generation and recreates adapter',
    first.publisherGeneration === 1 &&
      second.publisherGeneration === 2 &&
      adapterCreates.length === 2 &&
      adapterCloses.length === 1 &&
      secondTrack?.sessionId === 'publisher-session-2' &&
      secondTrack?.trackName === 'translated-recover-smoke-g2',
    JSON.stringify({
      first,
      second,
      adapterCreates: adapterCreates.length,
      adapterCloses: adapterCloses.length,
      secondTrack,
    })
  );
  check(
    'SFU publisher recovery preserves queued audio',
    queuedBefore > 0 && queuedAfter === queuedBefore,
    `(before ${queuedBefore}, after ${queuedAfter})`
  );

  await harness.close(['recover-smoke']);
  await fake.close();
}
{
  const fake = await startFakeRealtime({ connectBack: true });
  const harness = await startAudioFanoutHarness(fake);
  const markers = [];

  harness.fanout.publishTranslated('marker-smoke', makePcm24kToneBase64(1000), {
    track: 'translated',
    streamId: 'stream-smoke',
    audioSeq: 1,
    audioStartMs: 0,
    durationMs: 1000,
    onSent: (marker) => markers.push(marker),
  });
  const markerWasSynchronous = markers.length > 0;
  const drained = await waitUntil(() => markers.length > 0 && fake.ingestMessages.length > 0);
  const marker = markers[0];

  check(
    'SFU audio marker is delayed until ingest drain',
    !markerWasSynchronous &&
      drained &&
      marker?.publisherGeneration === 1 &&
      marker?.sfuSentAtMs >= marker?.serverSentAtMs &&
      typeof marker?.sfuQueueMs === 'number',
    JSON.stringify({ markerWasSynchronous, drained, marker, ingestMessages: fake.ingestMessages.length })
  );

  await harness.close(['marker-smoke']);
  await fake.close();
}

// ---- Test 11: operational backup + restore
console.log('\n[11] Backup and restore');
{
  const backupDir = path.join(DATA, 'backup-test');
  fs.rmSync(backupDir, { recursive: true, force: true });
  execFileSync(process.execPath, [
    'scripts/backup.mjs',
    '--database',
    env.DATABASE_PATH,
    '--uploads',
    env.UPLOADS_DIR,
    '--out',
    backupDir,
  ], { cwd: ROOT, env, stdio: 'pipe' });

  const manifest = JSON.parse(fs.readFileSync(path.join(backupDir, 'manifest.json'), 'utf8'));
  check(
    'backup includes database + uploaded PDF manifest',
    manifest.database?.bytes > 0 && manifest.uploads?.count >= 1 && fs.existsSync(path.join(backupDir, 'app.db')),
    JSON.stringify(manifest)
  );

  fs.rmSync(env.DATABASE_PATH, { force: true });
  fs.rmSync(`${env.DATABASE_PATH}-wal`, { force: true });
  fs.rmSync(`${env.DATABASE_PATH}-shm`, { force: true });
  fs.rmSync(env.UPLOADS_DIR, { recursive: true, force: true });

  execFileSync(process.execPath, [
    'scripts/restore.mjs',
    '--backup',
    backupDir,
    '--database',
    env.DATABASE_PATH,
    '--uploads',
    env.UPLOADS_DIR,
    '--force',
  ], { cwd: ROOT, env, stdio: 'pipe' });

  const server4 = startServer();
  await waitForHealth();
  const restored = await fetch(`${BASE}/api/sessions/${slug}`);
  const restoredInfo = await restored.json();
  check(
    'restored backup serves the existing session',
    restored.ok && restoredInfo.slug === slug,
    `(status ${restored.status}, body ${JSON.stringify(restoredInfo)}, slug ${slug})`
  );
  await stopProcess(server4);
}

// ---- Test 12: production hardening (viewer cap, host throttle, public-GET
// rate limit, gated test hooks). Own instance: low viewer cap + fresh limiter.
console.log('\n[12] Production hardening');
{
  const server5 = startServer({ MAX_VIEWERS_PER_SESSION: '2', PUBLIC_GET_MAX: '120' });
  if (!(await waitForHealth())) {
    console.error('hardening server failed to start');
    process.exit(1);
  }

  const form = new FormData();
  form.set('title', 'Hardening Talk');
  form.set('targetLang', 'es');
  form.set('slideType', 'pdf');
  form.set('file', new File([MINI_PDF], 'harden.pdf', { type: 'application/pdf' }));
  const created = await (
    await fetch(`${BASE}/api/sessions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${SECRET}` },
      body: form,
    })
  ).json();
  const hslug = created.slug;

  // (a) Analytics: same viewer in two tabs counts as one live attendee and one
  // active watch timer; attendee PII is sanitized and viewerId stays server-only.
  const [analyticsViewer1, analyticsViewer2] = await Promise.all([
    wsOpen(hslug, { role: 'viewer', viewerId: 'analytics-viewer', name: ' Alice\n\u0000 ', company: ' ACME\tCo ' }),
    wsOpen(hslug, { role: 'viewer', viewerId: 'analytics-viewer', name: ' Alice\n\u0000 ', company: ' ACME\tCo ' }),
  ]);
  await new Promise((r) => setTimeout(r, 500));
  const liveAnalyticsRes = await fetch(`${BASE}/api/sessions/${hslug}/analytics`, {
    headers: { Authorization: `Bearer ${SECRET}` },
  });
  const liveAnalytics = await liveAnalyticsRes.json();
  const analyticsAttendee = liveAnalytics.attendees?.find((a) => a.name === 'Alice');
  check(
    'analytics response is no-store',
    liveAnalyticsRes.headers.get('cache-control')?.includes('no-store'),
    `(cache-control ${liveAnalyticsRes.headers.get('cache-control')})`
  );
  check('analytics omits raw viewerId', !JSON.stringify(liveAnalytics).includes('analytics-viewer'));
  check(
    'analytics sanitizes attendee profile fields',
    analyticsAttendee?.name === 'Alice' && analyticsAttendee?.company === 'ACMECo',
    JSON.stringify(analyticsAttendee)
  );
  check(
    'same viewer in two tabs counts as one live analytics viewer',
    liveAnalytics.live === 1 && liveAnalytics.uniqueAttendees === 1,
    JSON.stringify({ live: liveAnalytics.live, uniqueAttendees: liveAnalytics.uniqueAttendees })
  );
  check(
    'same viewer in two tabs has one active watch timer',
    analyticsAttendee?.watchedMs >= 500 && analyticsAttendee.watchedMs < 2000,
    `(watched ${analyticsAttendee?.watchedMs})`
  );

  const analyticsHost = await wsOpen(hslug, { role: 'host', auth: SECRET });
  analyticsHost.ws.send(JSON.stringify({ type: 'control', ts: 0, seq: 0, payload: { action: 'stop' } }));
  await new Promise((r) => setTimeout(r, 300));
  const stoppedAnalytics = await (
    await fetch(`${BASE}/api/sessions/${hslug}/analytics`, {
      headers: { Authorization: `Bearer ${SECRET}` },
    })
  ).json();
  const stoppedAttendee = stoppedAnalytics.attendees?.find((a) => a.name === 'Alice');
  check(
    'stop flushes in-progress analytics watch time',
    stoppedAnalytics.state === 'ended' && stoppedAttendee?.watchedMs >= analyticsAttendee.watchedMs,
    JSON.stringify({ state: stoppedAnalytics.state, before: analyticsAttendee?.watchedMs, after: stoppedAttendee?.watchedMs })
  );
  analyticsViewer1.ws.close();
  analyticsViewer2.ws.close();
  analyticsHost.ws.close();
  await new Promise((r) => setTimeout(r, 300));

  seedAttendees(hslug, 505);
  const truncatedAnalytics = await (
    await fetch(`${BASE}/api/sessions/${hslug}/analytics`, {
      headers: { Authorization: `Bearer ${SECRET}` },
    })
  ).json();
  check(
    'analytics attendee list is capped while aggregates include all attendees',
    truncatedAnalytics.attendeeListTruncated === true &&
      truncatedAnalytics.attendeeLimit === 500 &&
      truncatedAnalytics.attendees.length === 500 &&
      truncatedAnalytics.uniqueAttendees >= 506,
    JSON.stringify({
      truncated: truncatedAnalytics.attendeeListTruncated,
      limit: truncatedAnalytics.attendeeLimit,
      rows: truncatedAnalytics.attendees?.length,
      unique: truncatedAnalytics.uniqueAttendees,
    })
  );

  // (b) Viewer cap: the 3rd concurrent viewer on a cap-2 room is closed with 4409.
  const v1 = await wsOpen(hslug, { role: 'viewer' });
  const v2 = await wsOpen(hslug, { role: 'viewer' });
  const v3 = await wsOpen(hslug, { role: 'viewer' });
  check('viewer beyond MAX_VIEWERS_PER_SESSION is rejected (4409)', v3.closeCode() === 4409, `(close ${v3.closeCode()})`);
  v1.ws.close();
  v2.ws.close();
  v3.ws.close();
  await new Promise((r) => setTimeout(r, 200)); // let the server free the slots

  // (c) Host control-plane flood is throttled: a watching viewer sees far fewer
  // slide changes than were sent (≈30/5s ceiling), and nothing crashes.
  const watcher = await wsOpen(hslug, { role: 'viewer' });
  const hostFlood = await wsOpen(hslug, { role: 'host', auth: SECRET });
  for (let i = 1; i <= 60; i++) {
    hostFlood.ws.send(JSON.stringify({ type: 'slide.change', ts: 0, seq: 0, payload: { index: i } }));
  }
  await new Promise((r) => setTimeout(r, 500));
  const slideChanges = watcher.messages.filter((m) => m.type === 'slide.change').length;
  const flooded = await fetch(`${BASE}/healthz`);
  check(
    'host slide flood is throttled (fewer applied than sent, server alive)',
    slideChanges > 0 && slideChanges < 60 && flooded.ok && hostFlood.closeCode() === null,
    `(applied ${slideChanges}/60)`
  );
  watcher.ws.close();

  // (d) Test-only control hook is ignored (no-op) when ENABLE_TEST_HOOKS is off.
  const hookHost = await wsOpen(hslug, { role: 'host', auth: SECRET });
  hookHost.ws.send(JSON.stringify({ type: 'control', ts: 0, seq: 0, payload: { action: 'kill_gemini_test' } }));
  await new Promise((r) => setTimeout(r, 300));
  const afterHook = await fetch(`${BASE}/healthz`);
  check('kill_gemini_test is a no-op when test hooks are disabled', hookHost.closeCode() === null && afterHook.ok);
  hookHost.ws.close();

  // (e) Analytics auth uses the same failed-auth limiter as admin routes.
  const badAnalytics = await fetch(`${BASE}/api/sessions/${hslug}/analytics`, {
    headers: { Authorization: 'Bearer wrong-key' },
  });
  let lastAnalyticsAuth = badAnalytics.status;
  for (let i = 0; i < 6; i++) {
    const r = await fetch(`${BASE}/api/sessions/${hslug}/analytics`, {
      headers: { Authorization: 'Bearer wrong-key' },
    });
    lastAnalyticsAuth = r.status;
  }
  check('wrong analytics key returns 401', badAnalytics.status === 401, `(got ${badAnalytics.status})`);
  check('analytics auth failures are rate-limited (429)', lastAnalyticsAuth === 429, `(got ${lastAnalyticsAuth})`);

  // (f) Unauthenticated public reads are rate-limited per IP. Run last — this
  // intentionally burns the window for 127.0.0.1 on this instance.
  let lastPublic = 0;
  let sawLimit = false;
  for (let i = 0; i < 130; i++) {
    const r = await fetch(`${BASE}/api/sessions/${hslug}`);
    lastPublic = r.status;
    if (r.status === 429) sawLimit = true;
  }
  check('unauthenticated public reads are rate-limited (429)', sawLimit && lastPublic === 429, `(last ${lastPublic})`);

  await stopProcess(server5);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
