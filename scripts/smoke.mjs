/**
 * Smoke test for the acceptance criteria that are verifiable without a real
 * microphone or Gemini API key (#1 partial, #6, #7, #8, snapshot-on-join).
 * Run: node scripts/smoke.mjs
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
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
  PORT: String(PORT),
  ADMIN_SECRET: SECRET,
  GEMINI_API_KEY: 'fake-key-for-smoke-test',
  DATABASE_PATH: path.join(DATA, 'app.db'),
  UPLOADS_DIR: path.join(DATA, 'uploads'),
  TRIAL_TTL_MS: '700',
  VALIDATE_TRIAL_GEMINI_KEYS: 'false',
  PUBLIC_ORIGIN: '',
  AUDIO_SUBSCRIPTION_ACTIVE: 'false',
  CF_REALTIME_APP_ID: '',
  CF_REALTIME_APP_SECRET: '',
  CF_REALTIME_API_BASE: '',
  MAX_VIEWERS_PER_SESSION: '500',
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

// ---- Test 0: SFU packet framing carries correct real-time durations
// (the pacer feeds the SFU at 1× using these durations, so they must be exact).
console.log('\n[0] SFU audio packet pacing math');
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
  const badTtlEnv = { ...env, TRIAL_TTL_MS: '0' };
  const { tmpdir } = await import('node:os');
  const proc = spawn('node', [path.join(ROOT, 'server/dist/index.js')], {
    cwd: tmpdir(),
    env: badTtlEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  proc.stderr.on('data', (d) => (stderr += d));
  const code = await new Promise((r) => proc.on('exit', r));
  check('boot fails with invalid TRIAL_TTL_MS', code !== 0 && stderr.includes('TRIAL_TTL_MS'), `(code ${code})`);
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
    'TRIAL_TTL_MS',
    'PUBLIC_ORIGIN',
    'TRUST_PROXY',
    'MAX_VIEWERS_PER_SESSION',
    'PUBLIC_GET_MAX',
    'SENTRY_DSN',
    'ENABLE_TEST_HOOKS',
    'VALIDATE_TRIAL_GEMINI_KEYS',
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
  check('healthz verifies runtime dependencies', health.ok && healthBody?.ok === true);

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
      !JSON.stringify(info).includes(SECRET)
  );
  check(
    'public session info marks audio unavailable when the operator gate is off',
    info.audio?.available === false && info.audio?.reason === 'subscription_inactive',
    JSON.stringify(info.audio)
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
  check('uploaded PDF is served', pdf.ok && (await pdf.text()).startsWith('%PDF'));
  const langs = await (await fetch(`${BASE}/api/languages`)).json();
  check('language table has 70+ entries', Array.isArray(langs) && langs.length >= 70, `(got ${langs.length})`);

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

  const uploadsBeforeBadTrial = fs.existsSync(env.UPLOADS_DIR)
    ? fs.readdirSync(env.UPLOADS_DIR).sort().join('|')
    : '';
  const badTrial = new FormData();
  badTrial.set('geminiApiKey', 'short');
  badTrial.set('title', 'Bad Trial');
  badTrial.set('targetLang', 'es');
  badTrial.set('slideType', 'pdf');
  badTrial.set('file', new File([MINI_PDF], 'trial.pdf', { type: 'application/pdf' }));
  const badTrialRes = await fetch(`${BASE}/api/try`, { method: 'POST', body: badTrial });
  const uploadsAfterBadTrial = fs.existsSync(env.UPLOADS_DIR)
    ? fs.readdirSync(env.UPLOADS_DIR).sort().join('|')
    : '';
  check('invalid trial upload is cleaned up', badTrialRes.status === 400 && uploadsAfterBadTrial === uploadsBeforeBadTrial);

  const badTrialAuditDb = new Database(env.DATABASE_PATH);
  const badTrialAudit = badTrialAuditDb
    .prepare(`SELECT * FROM trial_abuse_events WHERE flow = 'try' AND reason = 'invalid_key_format' ORDER BY id DESC LIMIT 1`)
    .get();
  badTrialAuditDb.close();
  check('invalid trial key format is audited durably', !!badTrialAudit && badTrialAudit.allowed === 0);

  const activeTrial = new FormData();
  activeTrial.set('geminiApiKey', 'fake-trial-key');
  activeTrial.set('title', 'Active Trial');
  activeTrial.set('targetLang', 'es');
  activeTrial.set('slideType', 'pdf');
  activeTrial.set('file', new File([MINI_PDF], 'active-trial.pdf', { type: 'application/pdf' }));
  const activeTrialRes = await fetch(`${BASE}/api/try`, { method: 'POST', body: activeTrial });
  const activeTrialBody = await activeTrialRes.json();
  const activeTrialHost = await wsOpen(activeTrialBody.slug, { role: 'host', auth: activeTrialBody.hostToken });
  const activeTrialAnalytics = await fetch(`${BASE}/api/sessions/${activeTrialBody.slug}/analytics`, {
    headers: { Authorization: `Bearer ${activeTrialBody.hostToken}` },
  });
  await new Promise((r) => setTimeout(r, 1100));
  const activeTrialStillThere = await fetch(`${BASE}/api/sessions/${activeTrialBody.slug}`);
  check('active trial is not deleted mid-session at TTL', activeTrialRes.ok && activeTrialHost.messages.some((m) => m.type === 'snapshot') && activeTrialStillThere.ok);
  check('trial host token can read session analytics', activeTrialAnalytics.ok, `(status ${activeTrialAnalytics.status})`);
  activeTrialHost.ws.close();
  await new Promise((r) => setTimeout(r, 900));
  const activeTrialAfterClose = await fetch(`${BASE}/api/sessions/${activeTrialBody.slug}`);
  check('active trial expires after sockets close', activeTrialAfterClose.status === 404, `(got ${activeTrialAfterClose.status})`);

  const trial = new FormData();
  trial.set('geminiApiKey', 'fake-trial-key');
  trial.set('title', 'Expiring Trial');
  trial.set('targetLang', 'es');
  trial.set('slideType', 'pdf');
  trial.set('file', new File([MINI_PDF], 'trial.pdf', { type: 'application/pdf' }));
  const trialRes = await fetch(`${BASE}/api/try`, { method: 'POST', body: trial });
  const trialBody = await trialRes.json();
  const trialInfo = await (await fetch(`${BASE}/api/sessions/${trialBody.slug}`)).json();
  const trialPdfBefore = await fetch(`${BASE}${trialInfo.slideUrl}`);
  await new Promise((r) => setTimeout(r, 1100));
  const trialAfter = await fetch(`${BASE}/api/sessions/${trialBody.slug}`);
  const trialPdfAfter = await fetch(`${BASE}${trialInfo.slideUrl}`);
  check('trial expires and removes its uploaded PDF', trialRes.ok && trialPdfBefore.ok && trialAfter.status === 404 && trialPdfAfter.status === 404);
  check(
    'own-key trial reports 15 minutes and a 10 viewer cap',
    trialInfo.trialRuntimeMs === 900_000 && trialInfo.trialMaxViewers === 10,
    JSON.stringify(trialInfo)
  );

  const tryRateStatuses = [];
  // The limiter uses wall-clock-aligned one-minute windows. A three-request
  // assertion can straddle a boundary and miss the requests made just above.
  // Eleven immediate attempts guarantee that at least six land in the same
  // window, even when the sequence crosses one boundary.
  for (let i = 0; i < 11 && !tryRateStatuses.includes(429); i += 1) {
    const res = await fetch(`${BASE}/api/try`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        geminiApiKey: 'fake-trial-key',
        title: `Rate Trial ${i}`,
        targetLang: 'es',
        slideType: 'html',
        slideUrl: `https://example.com/rate-trial-${i}.html`,
      }),
    });
    tryRateStatuses.push(res.status);
  }
  check(
    'own-key trial creation is durably rate-limited by IP',
    tryRateStatuses.at(-1) === 429 && tryRateStatuses.slice(0, -1).every((status) => status === 200),
    JSON.stringify(tryRateStatuses)
  );
  const tryRateAuditDb = new Database(env.DATABASE_PATH);
  const tryRateAudit = tryRateAuditDb
    .prepare(`SELECT * FROM trial_abuse_events WHERE flow = 'try' AND reason = 'rate_limited_ip' ORDER BY id DESC LIMIT 1`)
    .get();
  tryRateAuditDb.close();
  check('own-key trial rate-limit denial is audited durably', !!tryRateAudit && tryRateAudit.allowed === 0);

  const betaEmailLocal = `beta${Date.now()}`;
  const beta = new FormData();
  beta.set('fullName', 'Beta Lead');
  beta.set('email', `${betaEmailLocal}+trial@acme.co`);
  beta.set('company', 'Acme Co');
  beta.set('budget', '$50-$100/hour');
  beta.set('title', 'Hosted Beta Trial');
  beta.set('targetLang', 'es');
  beta.set('presentationMode', 'remote');
  beta.set('slideType', 'html');
  beta.set('slideUrl', 'https://example.com/beta-deck.html');
  const betaRes = await fetch(`${BASE}/api/beta/trial`, { method: 'POST', body: beta });
  const betaBody = await betaRes.json();
  const betaInfo = await (await fetch(`${BASE}/api/sessions/${betaBody.slug}`)).json();
  const betaAnalytics = await fetch(`${BASE}/api/sessions/${betaBody.slug}/analytics`, {
    headers: { Authorization: `Bearer ${betaBody.hostToken}` },
  });
  check(
    'hosted beta creates a one-keyless trial session',
    betaRes.ok &&
      betaBody.hostToken &&
      betaInfo.trialKind === 'beta' &&
      betaInfo.trialRuntimeMs === 120_000 &&
      betaInfo.trialMaxViewers === 10 &&
      betaInfo.slideType === 'html' &&
      !JSON.stringify(betaInfo).includes(env.GEMINI_API_KEY),
    JSON.stringify({ status: betaRes.status, body: betaBody, info: betaInfo })
  );
  check('hosted beta host token can read analytics', betaAnalytics.ok, `(status ${betaAnalytics.status})`);

  const betaExpediteRes = await fetch(`${BASE}/api/beta/trial/${betaBody.slug}/expedite`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${betaBody.hostToken}` },
  });
  const betaExpedite = await betaExpediteRes.json();
  const betaFeedbackRes = await fetch(`${BASE}/api/beta/trial/${betaBody.slug}/feedback`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${betaBody.hostToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ rating: 5, feedback: 'Smoke feedback' }),
  });
  const betaFeedback = await betaFeedbackRes.json();
  check(
    'hosted beta records expedite request and feedback with host token',
    betaExpediteRes.ok &&
      betaExpedite.expediteRequested === true &&
      betaFeedbackRes.ok &&
      betaFeedback.rating === 5 &&
      betaFeedback.feedback === 'Smoke feedback',
    JSON.stringify({ betaExpedite, betaFeedback })
  );

  const betaViewers = [];
  const betaHost = await wsOpen(betaBody.slug, { role: 'host', auth: betaBody.hostToken });
  for (let i = 0; i < 10; i += 1) {
    betaViewers.push(await wsOpen(betaBody.slug, { role: 'viewer', viewerId: `beta-viewer-${i}` }));
  }
  const betaViewerOverCap = await wsOpen(betaBody.slug, { role: 'viewer', viewerId: 'beta-viewer-over-cap' });
  check(
    'hosted beta allows 10 viewers and rejects the 11th',
    betaViewers.every((v) => v.messages.some((m) => m.type === 'snapshot')) &&
      betaViewerOverCap.closeCode() === 4409,
    `(close ${betaViewerOverCap.closeCode()})`
  );
  betaHost.ws.close();
  betaViewers.forEach((v) => v.ws.close());
  betaViewerOverCap.ws.close();
  await new Promise((r) => setTimeout(r, 300));

  const dupBeta = new FormData();
  dupBeta.set('fullName', 'Beta Lead Again');
  dupBeta.set('email', `${betaEmailLocal}@acme.co`);
  dupBeta.set('company', 'Acme Co');
  dupBeta.set('budget', '$50-$100/hour');
  dupBeta.set('title', 'Duplicate Hosted Beta Trial');
  dupBeta.set('targetLang', 'es');
  dupBeta.set('slideType', 'html');
  dupBeta.set('slideUrl', 'https://example.com/duplicate-beta-deck.html');
  const dupBetaRes = await fetch(`${BASE}/api/beta/trial`, { method: 'POST', body: dupBeta });
  check('duplicate beta email is rejected', dupBetaRes.status === 409, `(got ${dupBetaRes.status})`);

  const fakeBeta = new FormData();
  fakeBeta.set('fullName', 'Fake Lead');
  fakeBeta.set('email', 'demo@mailinator.com');
  fakeBeta.set('company', 'Fake Co');
  fakeBeta.set('budget', 'Not sure yet');
  fakeBeta.set('title', 'Fake Hosted Beta Trial');
  fakeBeta.set('targetLang', 'es');
  fakeBeta.set('slideType', 'html');
  fakeBeta.set('slideUrl', 'https://example.com/fake-beta-deck.html');
  const fakeBetaRes = await fetch(`${BASE}/api/beta/trial`, { method: 'POST', body: fakeBeta });
  check('fake/disposable beta email is rejected', fakeBetaRes.status === 400, `(got ${fakeBetaRes.status})`);

  const betaAuditDb = new Database(env.DATABASE_PATH);
  const betaSuccessAudit = betaAuditDb
    .prepare(`SELECT * FROM trial_abuse_events WHERE flow = 'beta' AND reason = 'created' AND session_slug = ?`)
    .get(betaBody.slug);
  const betaInvalidAudit = betaAuditDb
    .prepare(`SELECT * FROM trial_abuse_events WHERE flow = 'beta' AND reason = 'invalid_lead' ORDER BY id DESC LIMIT 1`)
    .get();
  const betaRateRows = betaAuditDb
    .prepare(`SELECT * FROM trial_rate_limits WHERE scope = 'trial_create:beta:ip'`)
    .all();
  betaAuditDb.close();
  check('beta trial success and invalid lead attempts are audited durably', !!betaSuccessAudit && betaSuccessAudit.allowed === 1 && !!betaInvalidAudit && betaInvalidAudit.allowed === 0);
  check('beta trial creation rate limit state is durable', betaRateRows.length > 0);

  const bigBetaPdf = new FormData();
  bigBetaPdf.set('fullName', 'Big Pdf Lead');
  bigBetaPdf.set('email', `bigpdf${Date.now()}@acme.co`);
  bigBetaPdf.set('company', 'Acme Co');
  bigBetaPdf.set('budget', '$100-$150/hour');
  bigBetaPdf.set('title', 'Big PDF Hosted Beta Trial');
  bigBetaPdf.set('targetLang', 'es');
  bigBetaPdf.set('slideType', 'pdf');
  bigBetaPdf.set('file', new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'too-big.pdf', { type: 'application/pdf' }));
  const bigBetaPdfRes = await fetch(`${BASE}/api/beta/trial`, { method: 'POST', body: bigBetaPdf });
  check('hosted beta rejects PDF uploads over 5 MB', bigBetaPdfRes.status === 400, `(got ${bigBetaPdfRes.status})`);

  const betaLeadsRes = await fetch(`${BASE}/api/beta/leads`, {
    headers: { Authorization: `Bearer ${SECRET}` },
  });
  const betaLeads = await betaLeadsRes.json();
  const betaLead = betaLeads.find((lead) => lead.sessionSlug === betaBody.slug);
  check(
    'admin beta leads include lead details and duplicate counters',
    betaLeadsRes.ok &&
      betaLead?.email === `${betaEmailLocal}+trial@acme.co` &&
      betaLead?.fullName === 'Beta Lead' &&
      betaLead?.company === 'Acme Co' &&
      betaLead?.budget === '$50-$100/hour' &&
      betaLead?.duplicateAttempts === 1 &&
      betaLead?.expediteRequested === true &&
      betaLead?.feedbackRating === 5 &&
      betaLead?.feedback === 'Smoke feedback' &&
      typeof betaLead?.lastDuplicateAt === 'string',
    JSON.stringify(betaLead)
  );
}

// ---- Test 9: WS auth + read-only viewers (criterion #7)
console.log('\n[9] WebSocket roles');
{
  const viewer = await wsOpen(slug, { role: 'viewer' });
  const snap = viewer.messages.find((m) => m.type === 'snapshot');
  check('viewer receives snapshot on connect', !!snap && snap.payload.state === 'created' && snap.payload.slideIndex === 0);

  viewer.ws.send(JSON.stringify({ type: 'slide.change', ts: 0, seq: 0, payload: { index: 5 } }));
  await new Promise((r) => setTimeout(r, 500));
  check('viewer publishing slide.change is rejected + closed', viewer.closeCode() === 4403, `(close ${viewer.closeCode()})`);

  const badHost = await wsOpen(slug, { role: 'host', auth: 'wrong-secret' });
  check('host with wrong secret is rejected (4401)', badHost.closeCode() === 4401, `(close ${badHost.closeCode()})`);

  const host = await wsOpen(slug, { role: 'host', auth: SECRET });
  check('host with correct secret gets snapshot', host.messages.some((m) => m.type === 'snapshot'));

  const removedResourceRole = await wsOpen(slug, { role: 'resource' });
  check('removed resource role is rejected', removedResourceRole.closeCode() === 4403, `(close ${removedResourceRole.closeCode()})`);

  // host changes slide → late-joining viewer lands on it (criterion #3, late join)
  const viewer2 = await wsOpen(slug, { role: 'viewer' });
  host.ws.send(JSON.stringify({
    type: 'poll.open',
    ts: 0,
    seq: 0,
    payload: { question: 'Ready for the next slide?', options: ['Yes', 'No'] },
  }));
  host.ws.send(JSON.stringify({ type: 'slide.change', ts: 0, seq: 0, payload: { index: 2 } }));
  await new Promise((r) => setTimeout(r, 400));
  const slideMsg = viewer2.messages.find((m) => m.type === 'slide.change');
  check('viewer receives slide.change from host', slideMsg?.payload.index === 2);
  const lateViewer = await wsOpen(slug, { role: 'viewer' });
  const lateSnap = lateViewer.messages.find((m) => m.type === 'snapshot');
  check('late joiner lands on slide 3 (index 2)', lateSnap?.payload.slideIndex === 2);

  const presence = host.messages.find((m) => m.type === 'presence');
  check('host receives presence (viewer count)', !!presence);

  host.ws.close();
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
