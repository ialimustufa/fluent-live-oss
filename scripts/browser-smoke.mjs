#!/usr/bin/env node
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 3188;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = path.join(ROOT, 'data', 'browser-smoke');
const SECRET = 'browser-smoke-secret-long-enough';

const env = {
  ...process.env,
  PORT: String(PORT),
  ADMIN_SECRET: SECRET,
  GEMINI_API_KEY: 'fake-key-for-browser-smoke',
  DATABASE_PATH: path.join(DATA, 'app.db'),
  UPLOADS_DIR: path.join(DATA, 'uploads'),
  PUBLIC_ORIGIN: BASE,
};

let passed = 0;
let failed = 0;
function check(name, ok, extra = '') {
  if (ok) {
    passed += 1;
    console.log(`  ✅ ${name}`);
  } else {
    failed += 1;
    console.log(`  ❌ ${name} ${extra}`);
  }
}

function makePdf() {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Length 48 >>\nstream\nBT /F1 24 Tf 72 720 Td (Browser Smoke) Tj ET\nendstream',
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

function startServer() {
  return spawn('node', ['server/dist/index.js'], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function stopServer(proc) {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  const exited = new Promise((resolve) => proc.once('exit', resolve));
  proc.kill();
  const timer = setTimeout(() => proc.kill('SIGKILL'), 12_000);
  timer.unref?.();
  await exited;
  clearTimeout(timer);
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

async function createPdfSession(title = 'Browser Smoke PDF') {
  const form = new FormData();
  form.set('title', title);
  form.set('targetLang', 'es');
  form.set('slideType', 'pdf');
  form.set('file', new File([makePdf()], 'browser-smoke.pdf', { type: 'application/pdf' }));
  const res = await fetch(`${BASE}/api/sessions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${SECRET}` },
    body: form,
  });
  if (!res.ok) throw new Error(`create session HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

async function createBetaTrialSession() {
  const form = new FormData();
  form.set('fullName', 'Browser Smoke Beta');
  form.set('email', `browser-smoke-beta-${Date.now()}@acme.co`);
  form.set('company', 'Acme Co');
  form.set('budget', '$50-$100/hour');
  form.set('title', 'Browser Smoke Beta');
  form.set('targetLang', 'es');
  form.set('presentationMode', 'remote');
  form.set('slideType', 'pdf');
  form.set('file', new File([makePdf()], 'browser-smoke-beta.pdf', { type: 'application/pdf' }));
  const res = await fetch(`${BASE}/api/beta/trial`, { method: 'POST', body: form });
  if (!res.ok) throw new Error(`create beta trial HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

async function connectHost(slug) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/${slug}`);
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error('timed out connecting browser smoke host'));
    }, 5000);
    let settled = false;
    let seq = 0;
    const send = (type, payload) => {
      ws.send(JSON.stringify({ type, ts: Date.now(), seq: seq++, payload }));
    };

    ws.on('open', () => send('hello', { role: 'host', auth: SECRET }));
    ws.on('message', (data) => {
      const message = JSON.parse(data.toString());
      if (!settled && message.type === 'snapshot') {
        settled = true;
        clearTimeout(timeout);
        resolve({ ws, send });
      }
    });
    ws.on('close', (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(new Error(`browser smoke host closed before snapshot (${code})`));
      }
    });
    ws.on('error', (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(error);
      }
    });
  });
}

async function endSession(slug) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/${slug}`);
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error('timed out ending browser smoke session'));
    }, 5000);
    let seq = 0;
    ws.on('open', () => {
      ws.send(JSON.stringify({
        type: 'hello',
        ts: Date.now(),
        seq: seq++,
        payload: { role: 'host', auth: SECRET },
      }));
    });
    ws.on('message', (data) => {
      const message = JSON.parse(data.toString());
      if (message.type === 'snapshot') {
        ws.send(JSON.stringify({ type: 'control', ts: Date.now(), seq: seq++, payload: { action: 'stop' } }));
      } else if (message.type === 'session.state' && message.payload?.state === 'ended') {
        clearTimeout(timeout);
        ws.close();
        resolve();
      }
    });
    ws.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

async function visible(locator) {
  try {
    return await locator.isVisible();
  } catch {
    return false;
  }
}

async function checkNoPersonalSignupUi(page, label) {
  const attribution = page.getByText(/^Made by\b/i);
  const personalIdentityLinks = page.locator('a[href*="google.com/search"]');
  const externalSignupUi = page.locator([
    'a[href*="forms.gle"]',
    'a[href*="docs.google.com/forms"]',
    'iframe[src*="forms.gle"]',
    'iframe[src*="docs.google.com/forms"]',
  ].join(','));
  check(
    `${label} renders no personal attribution/footer`,
    (await attribution.count()) === 0 && (await personalIdentityLinks.count()) === 0
  );
  check(
    `${label} renders no external signup form, link, or iframe`,
    (await externalSignupUi.count()) === 0
  );
}

async function checkNoResourceUi(page, label) {
  const resourceControls = page.getByRole('button', { name: /resources?/i });
  const resourceLinks = page.locator('a[href$="/resource"], a[href*="/resource/"]');
  const resourceCopy = page.getByText(/Audience resources/i);
  check(
    `${label} renders no session-resource UI`,
    (await resourceControls.count()) === 0 &&
      (await resourceLinks.count()) === 0 &&
      (await resourceCopy.count()) === 0
  );
}

fs.rmSync(DATA, { recursive: true, force: true });

if (!fs.existsSync(path.join(ROOT, 'client', 'dist', 'index.html'))) {
  console.error('browser smoke requires a built client; run npm run build first');
  process.exit(1);
}

console.log('\n[Browser smoke]');
let server = startServer();
server.stderr.on('data', (d) => process.env.SMOKE_DEBUG && console.error(String(d)));

let browser;
try {
  check('bootstrap server health is ready', await waitForHealth());
  const created = await createPdfSession();
  await stopServer(server);

  server = startServer();
  server.stderr.on('data', (d) => process.env.SMOKE_DEBUG && console.error(String(d)));
  check('restarted server health is ready', await waitForHealth());

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const consoleErrors = [];
  const missingResponses = [];
  const rootPdfRequests = [];
  const viewerPdfRequests = [];
  const analyticsRequests = [];
  const hostAnalyticsRequests = [];
  let phase = 'root';

  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('response', (res) => {
    if (res.status() === 404) missingResponses.push(res.url());
  });
  page.on('request', (req) => {
    if (/googletagmanager\.com|google-analytics\.com/.test(req.url())) {
      analyticsRequests.push(req.url());
    }
    const url = new URL(req.url());
    if (url.origin === BASE && /\/api\/sessions\/[^/]+\/analytics$/.test(url.pathname)) {
      hostAnalyticsRequests.push(req.url());
    }
    if (/PdfViewer|pdf\.worker|pdfjs/.test(req.url())) {
      if (phase === 'root') rootPdfRequests.push(req.url());
      else viewerPdfRequests.push(req.url());
    }
  });
  await page.route('https://www.googletagmanager.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/javascript', body: '' })
  );
  await page.route('https://fonts.googleapis.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/css', body: '' })
  );
  await page.route('https://www.google-analytics.com/**', (route) => route.fulfill({ status: 204, body: '' }));
  await page.route('https://region1.google-analytics.com/**', (route) => route.fulfill({ status: 204, body: '' }));

  const root = await page.goto(BASE, { waitUntil: 'networkidle' });
  const rootCsp = root?.headers()['content-security-policy'] ?? '';
  await page.getByRole('heading', { name: 'Fluent' }).waitFor();
  check('home page loads with CSP', root?.ok() && rootCsp.includes("default-src 'self'"));
  check('home page does not load PDF chunk', rootPdfRequests.length === 0, rootPdfRequests.join('\n'));
  await checkNoPersonalSignupUi(page, 'home page');

  await page.goto(`${BASE}/try`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: /Start a test presentation/i }).waitFor();
  await checkNoPersonalSignupUi(page, 'trial page');

  phase = 'viewer';
  await page.goto(`${BASE}/${created.slug}/resource`, { waitUntil: 'networkidle' });
  await page.waitForURL(`${BASE}${created.viewerPath}`);
  check('legacy /:slug/resource route redirects to the viewer', new URL(page.url()).pathname === created.viewerPath);
  await page.goto(`${BASE}/resource/${created.slug}`, { waitUntil: 'networkidle' });
  await page.waitForURL(`${BASE}${created.viewerPath}`);
  check('legacy /resource/:slug route redirects to the viewer', new URL(page.url()).pathname === created.viewerPath);
  await page.getByRole('button', { name: /Enter the room/i }).click();
  await page.locator('canvas').waitFor({ timeout: 15000 });
  await page.waitForFunction(() => {
    const canvas = document.querySelector('canvas');
    return canvas instanceof HTMLCanvasElement && canvas.width > 0 && canvas.height > 0;
  });
  check('viewer renders uploaded PDF canvas', await page.locator('canvas').count() > 0);
  check('viewer lazy-loads PDF code only for PDF session', viewerPdfRequests.some((url) => url.includes('PdfViewer')), viewerPdfRequests.join('\n'));
  await checkNoResourceUi(page, 'viewer');

  const stagePage = await browser.newPage();
  await stagePage.goto(`${BASE}/${created.slug}/present`, { waitUntil: 'domcontentloaded' });
  await stagePage.locator('canvas').waitFor({ timeout: 15000 });
  await checkNoResourceUi(stagePage, 'projector');

  const interactiveHost = await connectHost(created.slug);
  interactiveHost.send('poll.open', {
    question: 'Browser smoke poll',
    options: ['Yes', 'No'],
  });
  await page.getByText('Browser smoke poll', { exact: true }).waitFor({ timeout: 5000 });
  await stagePage.getByText('Browser smoke poll', { exact: true }).waitFor({ timeout: 5000 });
  await page.getByRole('button', { name: 'Yes', exact: true }).click();
  await page.getByText('1 vote', { exact: true }).waitFor({ timeout: 5000 });
  await stagePage.getByText('1 vote', { exact: true }).waitFor({ timeout: 5000 });
  check('viewer can vote in a generic live poll', await page.getByText('1 vote', { exact: true }).isVisible());

  await page.getByRole('button', { name: 'React 👍', exact: true }).click();
  const stageReaction = stagePage.locator('.animate-float-up').filter({ hasText: '👍' });
  await stageReaction.waitFor({ timeout: 5000 });
  check('viewer reaction reaches the projector', await stageReaction.isVisible());
  interactiveHost.ws.close();
  await stagePage.close();

  hostAnalyticsRequests.length = 0;
  await page.evaluate((secret) => {
    sessionStorage.setItem(
      'fluent.adminKey',
      JSON.stringify({ key: secret, expiresAt: Date.now() + 24 * 60 * 60 * 1000 })
    );
  }, SECRET);
  const firstHostAnalytics = page.waitForResponse((res) => {
    const url = new URL(res.url());
    return url.origin === BASE && url.pathname === `/api/sessions/${created.slug}/analytics`;
  });
  await page.goto(`${BASE}${created.hostPath}`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: /Start/i }).waitFor({ timeout: 15000 });
  await firstHostAnalytics;
  await page.waitForTimeout(2500);
  await checkNoPersonalSignupUi(page, 'host page');
  check(
    'host analytics does not poll rapidly',
    hostAnalyticsRequests.length === 1,
    hostAnalyticsRequests.join('\n')
  );
  await page.getByRole('button', { name: /^Analytics$/i }).click();
  const beforeManualRefresh = hostAnalyticsRequests.length;
  const manualHostAnalytics = page.waitForResponse((res) => {
    const url = new URL(res.url());
    return url.origin === BASE && url.pathname === `/api/sessions/${created.slug}/analytics`;
  });
  await page.getByRole('button', { name: /Refresh attendance/i }).click();
  await manualHostAnalytics;
  check(
    'attendance refresh button fetches analytics once',
    hostAnalyticsRequests.length === beforeManualRefresh + 1,
    hostAnalyticsRequests.join('\n')
  );

  await endSession(created.slug);

  await page.goto(`${BASE}${created.viewerPath}`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: /has ended/i }).waitFor({ timeout: 5000 });
  const transcriptLink = page.getByRole('link', { name: /View the full transcript/i });
  check(
    'ended-session screen links to the transcript',
    (await transcriptLink.getAttribute('href')) === `/${created.slug}/transcript`
  );

  const betaCreated = await createBetaTrialSession();
  await page.evaluate(({ slug, hostToken }) => {
    sessionStorage.setItem(`fluent.trialHost.${slug}`, hostToken);
  }, betaCreated);
  await page.goto(`${BASE}${betaCreated.hostPath}`, { waitUntil: 'domcontentloaded' });
  const betaTour = page.getByRole('dialog', { name: /Beta setup tour/i });
  await betaTour.waitFor({ timeout: 15000 });
  check('beta host setup tour auto-opens', await visible(betaTour));
  check('beta host Start stays enabled during tour', await page.getByRole('button', { name: /^Start$/i }).isEnabled());

  for (let i = 0; i < 6; i += 1) {
    await betaTour.getByRole('button', { name: /^Next$/i }).click();
  }
  await betaTour.getByRole('heading', { name: /Live polls/i }).waitFor({ timeout: 5000 });
  const betaPollQuestion = page.getByPlaceholder('Poll / quiz question');
  await betaPollQuestion.waitFor({ timeout: 5000 });
  check(
    'beta tour advances to Polls tab',
    (await visible(betaTour.getByRole('heading', { name: /Live polls/i }))) &&
      (await visible(betaPollQuestion))
  );

  await betaTour.getByRole('button', { name: /^Next$/i }).click();
  await betaTour.getByRole('heading', { name: /^Analytics$/i }).waitFor({ timeout: 5000 });
  const betaAttendanceRefresh = page.getByRole('button', { name: /Refresh.*attendance/i });
  await betaAttendanceRefresh.waitFor({ timeout: 5000 });
  check(
    'beta tour advances to Analytics tab',
    (await visible(betaTour.getByRole('heading', { name: /^Analytics$/i }))) &&
      (await visible(betaAttendanceRefresh))
  );

  await betaTour.getByRole('button', { name: /^Skip tour$/i }).last().click();
  await page.waitForTimeout(100);
  check('beta tour skip closes dialog', !(await visible(betaTour)));

  await page.getByRole('button', { name: /^Setup$/i }).click();
  await page.getByRole('button', { name: /^Replay tour$/i }).click();
  await betaTour.waitFor({ timeout: 5000 });
  check('beta tour can be replayed after skip', await visible(betaTour));
  await betaTour.getByRole('button', { name: /^Skip tour$/i }).last().click();

  check('Google Analytics is not loaded without VITE_GA_MEASUREMENT_ID', analyticsRequests.length === 0, analyticsRequests.join('\n'));
  check(
    'browser console has no unexpected errors',
    consoleErrors.length === 0,
    [...consoleErrors, ...missingResponses.map((url) => `404 ${url}`)].join('\n')
  );
} catch (err) {
  check('browser smoke completed without exception', false, err instanceof Error ? err.message : String(err));
} finally {
  if (browser) await browser.close();
  await stopServer(server);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
