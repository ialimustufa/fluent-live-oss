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
  NODE_ENV: 'test',
  HOST: '127.0.0.1',
  PORT: String(PORT),
  ADMIN_SECRET: SECRET,
  GEMINI_API_KEY: 'fake-key-for-browser-smoke',
  DATABASE_PATH: path.join(DATA, 'app.db'),
  UPLOADS_DIR: path.join(DATA, 'uploads'),
  PUBLIC_ORIGIN: BASE,
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
    '<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Length 48 >>\nstream\nBT /F1 24 Tf 72 720 Td (Browser Smoke) Tj ET\nendstream',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 7 0 R >>',
    '<< /Length 52 >>\nstream\nBT /F1 24 Tf 72 720 Td (Browser Smoke Page 2) Tj ET\nendstream',
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

async function createPdfSession(title = 'Browser Smoke PDF', { audienceEnabled = true } = {}) {
  const form = new FormData();
  form.set('title', title);
  form.set('targetLang', 'es');
  form.set('audienceEnabled', String(audienceEnabled));
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

function analyticsProbeBundle() {
  const clientDist = path.join(ROOT, 'client', 'dist');
  const indexHtml = fs.readFileSync(path.join(clientDist, 'index.html'), 'utf8');
  const scriptMatch = indexHtml.match(/<script[^>]+src="([^"]*\/assets\/index-[^"]+\.js)"/);
  if (!scriptMatch) throw new Error('could not locate the built client entry script for analytics probing');

  const scriptUrl = new URL(scriptMatch[1], BASE);
  if (scriptUrl.origin !== BASE) {
    throw new Error(`analytics probe requires a same-origin client build, got ${scriptUrl.origin}`);
  }
  const scriptFile = path.join(clientDist, scriptUrl.pathname.replace(/^\/+/, ''));
  const source = fs.readFileSync(scriptFile, 'utf8');
  const analyticsMarker = source.indexOf('fluent_page_category');
  if (analyticsMarker < 0) throw new Error('built client is missing the analytics route tracker');

  // Verification builds intentionally disable GA. For this one browser probe,
  // bypass only the compiled analytics-initializer guard and supply a local
  // gtag spy via addInitScript below. Canonicalization and duplicate suppression
  // still run from the real production bundle, and no Google script is loaded.
  const probeStart = Math.max(0, analyticsMarker - 1_000);
  const probeEnd = Math.min(source.length, analyticsMarker + 200);
  const probeSlice = source.slice(probeStart, probeEnd);
  const initializerGuard = /![A-Za-z_$][\w$]*\(\)\|\|!window\.gtag/;
  if (!initializerGuard.test(probeSlice)) {
    throw new Error('could not isolate the built analytics initializer guard');
  }
  const patchedSlice = probeSlice.replace(initializerGuard, '!window.gtag');
  return {
    pathname: scriptUrl.pathname,
    source: source.slice(0, probeStart) + patchedSlice + source.slice(probeEnd),
  };
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
  const speakerCreated = await createPdfSession('Browser Smoke Speaker Stage', { audienceEnabled: false });
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
  const sessionInfoRequests = [];
  let phase = 'root';
  let tolerateConnectionRefused = false;

  const attachDiagnostics = (target, label) => {
    target.on('console', (msg) => {
      if (msg.type() !== 'error') return;
      const message = msg.text();
      if (
        message.includes('404 (Not Found)') &&
        new URL(target.url()).pathname === '/missing-host/host'
      ) return;
      if (tolerateConnectionRefused && message.includes('ERR_CONNECTION_REFUSED')) return;
      consoleErrors.push(`[${label}] ${message}`);
    });
    target.on('response', (res) => {
      if (res.status() !== 404) return;
      const url = new URL(res.url());
      if (url.origin === BASE && url.pathname === '/api/sessions/missing-host') return;
      missingResponses.push(`[${label}] ${res.url()}`);
    });
    target.on('request', (req) => {
      if (/googletagmanager\.com|google-analytics\.com/.test(req.url())) {
        analyticsRequests.push(req.url());
      }
      const url = new URL(req.url());
      if (url.origin === BASE && /^\/api\/sessions\/[^/]+$/.test(url.pathname)) {
        sessionInfoRequests.push(url.pathname);
      }
      if (url.origin === BASE && /\/api\/sessions\/[^/]+\/analytics$/.test(url.pathname)) {
        hostAnalyticsRequests.push(req.url());
      }
      if (/PdfViewer|pdf\.worker|pdfjs/.test(req.url())) {
        if (phase === 'root') rootPdfRequests.push(req.url());
        else viewerPdfRequests.push(req.url());
      }
    });
  };
  attachDiagnostics(page, 'main');
  await page.addInitScript(() => {
    const counts = { enumerateDevices: 0, getUserMedia: 0 };
    Object.defineProperty(window, '__fluentMediaCalls', { value: counts, configurable: true });
    const media = navigator.mediaDevices;
    if (!media) return;
    if (typeof media.enumerateDevices === 'function') {
      const original = media.enumerateDevices.bind(media);
      media.enumerateDevices = async (...args) => {
        counts.enumerateDevices += 1;
        return original(...args);
      };
    }
    if (typeof media.getUserMedia === 'function') {
      const original = media.getUserMedia.bind(media);
      media.getUserMedia = async (...args) => {
        counts.getUserMedia += 1;
        return original(...args);
      };
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
  const presenterAccess = page.getByRole('link', { name: 'Presenter access', exact: true });
  check(
    'home page presents a keyed presenter entry point',
    (await presenterAccess.getAttribute('href')) === '/new' &&
      (await page.getByText('Presenter key required.', { exact: true }).isVisible())
  );
  await checkNoPersonalSignupUi(page, 'home page');

  await presenterAccess.click();
  await page.getByRole('heading', { name: 'Presenter access', exact: true }).waitFor();
  const backToFluent = page.getByRole('link', { name: 'Back to Fluent', exact: true });
  check(
    'presenter gate has a clear home escape',
    (await backToFluent.getAttribute('href')) === '/'
  );
  await backToFluent.click();
  await page.waitForURL(`${BASE}/`);

  const analyticsProbe = analyticsProbeBundle();
  const retiredAnalyticsPage = await browser.newPage();
  const retiredAnalyticsRequests = [];
  attachDiagnostics(retiredAnalyticsPage, 'retired-analytics');
  retiredAnalyticsPage.on('request', (request) => {
    if (/googletagmanager\.com|google-analytics\.com/.test(request.url())) {
      retiredAnalyticsRequests.push(request.url());
    }
  });
  await retiredAnalyticsPage.addInitScript(() => {
    window.dataLayer = [];
    window.gtag = (...args) => window.dataLayer.push(args);
  });
  await retiredAnalyticsPage.route(`${BASE}${analyticsProbe.pathname}`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/javascript; charset=utf-8',
      body: analyticsProbe.source,
    })
  );
  await retiredAnalyticsPage.route('https://www.googletagmanager.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/javascript', body: '' })
  );
  await retiredAnalyticsPage.route('https://www.google-analytics.com/**', (route) =>
    route.fulfill({ status: 204, body: '' })
  );
  await retiredAnalyticsPage.route('https://region1.google-analytics.com/**', (route) =>
    route.fulfill({ status: 204, body: '' })
  );
  await retiredAnalyticsPage.route('https://fonts.googleapis.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/css', body: '' })
  );

  for (const retiredPath of ['/try', '/beta']) {
    await retiredAnalyticsPage.goto(`${BASE}${retiredPath}`, { waitUntil: 'domcontentloaded' });
    await retiredAnalyticsPage.waitForURL(`${BASE}/`);
    await retiredAnalyticsPage.waitForFunction(() =>
      window.dataLayer?.some(
        (entry) => Array.isArray(entry) && entry[0] === 'event' && entry[1] === 'page_view'
      )
    );
    const pageViews = await retiredAnalyticsPage.evaluate(() =>
      (window.dataLayer ?? [])
        .filter(
          (entry) => Array.isArray(entry) && entry[0] === 'event' && entry[1] === 'page_view'
        )
        .map((entry) => entry[2])
    );
    check(`${retiredPath} deliberately redirects home`, new URL(retiredAnalyticsPage.url()).pathname === '/');
    check(
      `${retiredPath} emits exactly one canonical home page_view`,
      pageViews.length === 1 &&
        pageViews[0]?.fluent_page_category === 'home' &&
        pageViews[0]?.page_path === '/home',
      JSON.stringify(pageViews)
    );
  }
  await retiredAnalyticsPage.close();
  check(
    'retired page redirects never request viewer session data',
    !sessionInfoRequests.includes('/api/sessions/try') &&
      !sessionInfoRequests.includes('/api/sessions/beta'),
    sessionInfoRequests.join('\n')
  );
  check(
    'retired route analytics stays hermetic',
    retiredAnalyticsRequests.length === 0,
    retiredAnalyticsRequests.join('\n')
  );

  await page.evaluate((secret) => {
    sessionStorage.setItem(
      'fluent.adminKey',
      JSON.stringify({ key: secret, expiresAt: Date.now() + 24 * 60 * 60 * 1000 })
    );
  }, SECRET);
  hostAnalyticsRequests.length = 0;
  await page.goto(`${BASE}/missing-host/host`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: 'Session not found', exact: true }).waitFor();
  const hostRecovery = page.getByRole('link', { name: 'Back to presenter dashboard', exact: true });
  const mediaCalls = await page.evaluate(() => window.__fluentMediaCalls);
  check(
    'missing Host renders recovery instead of hanging',
    (await hostRecovery.getAttribute('href')) === '/admin' &&
      (await page.getByText('This session was deleted or this link is no longer valid.', { exact: true }).isVisible())
  );
  check(
    'missing Host performs no device, microphone, or analytics work',
    mediaCalls.enumerateDevices === 0 && mediaCalls.getUserMedia === 0 && hostAnalyticsRequests.length === 0,
    JSON.stringify({ mediaCalls, hostAnalyticsRequests })
  );

  const rejectedHost = await browser.newPage();
  attachDiagnostics(rejectedHost, 'rejected-host');
  await rejectedHost.route(`${BASE}/api/auth/check`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' })
  );
  await rejectedHost.route(`${BASE}/api/sessions/${created.slug}/analytics`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        state: 'created',
        live: 0,
        uniqueAttendees: 0,
        peakConcurrent: 0,
        totalWatchMs: 0,
        avgWatchMs: 0,
        namedCount: 0,
        attendeeListTruncated: false,
        attendeeLimit: 500,
        attendees: [],
        reactions: {},
      }),
    })
  );
  await rejectedHost.goto(BASE, { waitUntil: 'domcontentloaded' });
  await rejectedHost.evaluate(() => {
    sessionStorage.setItem(
      'fluent.adminKey',
      JSON.stringify({ key: 'stale-host-key', expiresAt: Date.now() + 24 * 60 * 60 * 1000 })
    );
  });
  await rejectedHost.goto(`${BASE}${created.hostPath}`, { waitUntil: 'domcontentloaded' });
  await rejectedHost.getByRole('heading', { name: 'Presenter key rejected', exact: true }).waitFor();
  const reenterHostKey = rejectedHost.getByRole('button', { name: 'Re-enter presenter key', exact: true });
  check(
    'Host 4401 directs the operator to re-enter the presenter key',
    (await reenterHostKey.isVisible()) &&
      (await rejectedHost.getByText('Re-enter the presenter key to reconnect this host console.', { exact: true }).isVisible())
  );
  await reenterHostKey.click();
  await rejectedHost.getByRole('heading', { name: 'Presenter access', exact: true }).waitFor();
  check(
    'Host 4401 clears the stale key and reopens presenter access',
    (await rejectedHost.evaluate(() => sessionStorage.getItem('fluent.adminKey'))) === null
  );
  await rejectedHost.close();

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
  attachDiagnostics(stagePage, 'display-stage');
  await stagePage.goto(`${BASE}/${created.slug}/present`, { waitUntil: 'domcontentloaded' });
  await stagePage.locator('canvas').waitFor({ timeout: 15000 });
  await stagePage.getByText('Display-only stage', { exact: true }).waitFor({ timeout: 5000 });
  check(
    'unauthenticated stage is display-only',
    (await stagePage.getByRole('button', { name: 'Previous slide' }).count()) === 0 &&
      (await stagePage.getByRole('button', { name: 'Next slide' }).count()) === 0
  );
  await checkNoResourceUi(stagePage, 'projector');

  const rejectedStage = await browser.newPage();
  attachDiagnostics(rejectedStage, 'rejected-stage');
  await rejectedStage.goto(BASE, { waitUntil: 'domcontentloaded' });
  await rejectedStage.evaluate(() => {
    sessionStorage.setItem(
      'fluent.adminKey',
      JSON.stringify({ key: 'wrong-presenter-key', expiresAt: Date.now() + 24 * 60 * 60 * 1000 })
    );
  });
  await rejectedStage.goto(`${BASE}/${created.slug}/present`, { waitUntil: 'domcontentloaded' });
  await rejectedStage.getByText('Presenter key rejected; stage is read-only.', { exact: true }).waitFor();
  check(
    'invalid presenter key never exposes controls',
    (await rejectedStage.getByRole('button', { name: 'Next slide' }).count()) === 0
  );

  const presenterStage = await browser.newPage();
  attachDiagnostics(presenterStage, 'presenter-stage');
  await presenterStage.goto(BASE, { waitUntil: 'domcontentloaded' });
  await presenterStage.evaluate((secret) => {
    sessionStorage.setItem(
      'fluent.adminKey',
      JSON.stringify({ key: secret, expiresAt: Date.now() + 24 * 60 * 60 * 1000 })
    );
  }, SECRET);
  await presenterStage.goto(`${BASE}/${created.slug}/present`, { waitUntil: 'domcontentloaded' });
  const presenterNext = presenterStage.getByRole('button', { name: 'Next slide' });
  await presenterNext.waitFor({ timeout: 10000 });
  await presenterStage.getByText('Slide 1 / 2', { exact: true }).waitFor({ timeout: 10000 });
  check('valid presenter key receives server-authorized controls', await presenterNext.isEnabled());
  await presenterNext.click();
  await presenterStage.getByText('Slide 2 / 2', { exact: true }).waitFor();
  const presenterDrivenState = await (await fetch(`${BASE}/api/sessions/${created.slug}`)).json();
  check(
    'authenticated presenter UI changes the shared server slide',
    presenterDrivenState.slideIndex === 1,
    JSON.stringify(presenterDrivenState)
  );

  tolerateConnectionRefused = true;
  await stopServer(server);
  await presenterStage
    .getByRole('status')
    .filter({ hasText: 'Reconnecting to stage…' })
    .waitFor({ timeout: 5000 });
  check(
    'presenter controls disappear immediately on disconnect',
    (await presenterStage.getByRole('button', { name: 'Next slide' }).count()) === 0
  );
  server = startServer();
  server.stderr.on('data', (d) => process.env.SMOKE_DEBUG && console.error(String(d)));
  check('server restarts during presenter reconnect test', await waitForHealth());
  await presenterStage.getByRole('button', { name: 'Next slide' }).waitFor({ timeout: 15000 });
  tolerateConnectionRefused = false;
  check('presenter controls return only after reconnect authorization', true);
  await rejectedStage.close();
  await presenterStage.close();

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

  const beforeSpeakerHostAnalytics = hostAnalyticsRequests.length;
  let speakerHostSocketSeen = false;
  let speakerHostSocketClosed = false;
  page.on('websocket', (socket) => {
    if (new URL(socket.url()).pathname !== `/ws/${speakerCreated.slug}`) return;
    speakerHostSocketSeen = true;
    socket.on('close', () => {
      speakerHostSocketClosed = true;
    });
  });
  await page.goto(`${BASE}${speakerCreated.hostPath}`, { waitUntil: 'domcontentloaded' });
  await page.getByText('Speaker only', { exact: true }).waitFor({ timeout: 15000 });
  await page.getByText('live', { exact: true }).waitFor({ timeout: 5000 });
  await page.waitForTimeout(250);
  check(
    'speaker-only host renders local stage controls without audience UI',
    (await page.getByText('Local stage output', { exact: true }).isVisible()) &&
      (await page.getByRole('button', { name: /^Polls$/i }).count()) === 0 &&
      (await page.getByRole('button', { name: /^Analytics$/i }).count()) === 0 &&
      (await page.getByText('Audience link', { exact: true }).count()) === 0 &&
      (await page.getByText("Viewers' phones only", { exact: true }).count()) === 0
  );
  check(
    'speaker-only host does not request attendance analytics',
    hostAnalyticsRequests.length === beforeSpeakerHostAnalytics,
    hostAnalyticsRequests.slice(beforeSpeakerHostAnalytics).join('\n')
  );

  await page.setViewportSize({ width: 700, height: 900 });
  await page.locator('canvas').first().waitFor({ state: 'visible', timeout: 10000 });
  check(
    'speaker-only host keeps its slide deck visible below the md breakpoint',
    await page.locator('canvas').first().isVisible()
  );

  const speakerPresentPage = await browser.newPage();
  attachDiagnostics(speakerPresentPage, 'speaker-present');
  const speakerPresentSockets = [];
  speakerPresentPage.on('websocket', (socket) => speakerPresentSockets.push(socket.url()));
  await speakerPresentPage.goto(`${BASE}/${speakerCreated.slug}/present`, {
    waitUntil: 'domcontentloaded',
  });
  await speakerPresentPage
    .getByRole('heading', { name: /no projector for this speaker-only session/i })
    .waitFor({ timeout: 5000 });
  await speakerPresentPage.waitForTimeout(500);
  check(
    'speaker-only projector route is a socket-free notice and leaves the stage host connected',
    new URL(speakerPresentPage.url()).pathname === `/${speakerCreated.slug}/present` &&
      speakerPresentSockets.length === 0 &&
      speakerHostSocketSeen &&
      !speakerHostSocketClosed &&
      (await page.getByText('live', { exact: true }).isVisible()),
    JSON.stringify({ speakerPresentSockets, speakerHostSocketSeen, speakerHostSocketClosed })
  );

  await speakerPresentPage.goto(`${BASE}/${speakerCreated.slug}/transcript`, {
    waitUntil: 'domcontentloaded',
  });
  await speakerPresentPage
    .getByRole('heading', { name: 'Presenter access', exact: true })
    .waitFor({ timeout: 5000 });
  check(
    'speaker-only transcript prompts for the presenter key',
    await speakerPresentPage.getByRole('heading', { name: 'Presenter access', exact: true }).isVisible()
  );
  await speakerPresentPage.close();

  await page.goto(`${BASE}/${speakerCreated.slug}`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: /speaker-only session/i }).waitFor({ timeout: 5000 });
  check(
    'speaker-only viewer route stops before onboarding',
    (await page.getByRole('button', { name: /Enter the room/i }).count()) === 0
  );

  await endSession(created.slug);

  await page.goto(`${BASE}${created.viewerPath}`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: /has ended/i }).waitFor({ timeout: 5000 });
  const transcriptLink = page.getByRole('link', { name: /View the full transcript/i });
  check(
    'ended-session screen links to the transcript',
    (await transcriptLink.getAttribute('href')) === `/${created.slug}/transcript`
  );

  check('Google Analytics is not loaded without VITE_GA_MEASUREMENT_ID', analyticsRequests.length === 0, analyticsRequests.join('\n'));
  check(
    'browser console has no unexpected errors',
    consoleErrors.length === 0 && missingResponses.length === 0,
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
