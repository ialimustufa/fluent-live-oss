#!/usr/bin/env node
import process from 'node:process';

for (const file of ['.env', '../.env']) {
  try {
    process.loadEnvFile(file);
    break;
  } catch {
    /* ignore */
  }
}

function argValue(name) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : '';
}

const explicitBase = argValue('base') || process.env.SFU_CHECK_BASE_URL || '';
const port = process.env.PORT?.trim() || '3000';
const base =
  explicitBase ||
  process.env.PUBLIC_ORIGIN?.trim()?.replace(/\/+$/, '') ||
  `http://127.0.0.1:${port}`;
const adminSecret = process.env.ADMIN_SECRET?.trim() || '';
const timeoutMs = Number(argValue('timeout-ms') || process.env.SFU_CHECK_TIMEOUT_MS || '5000');

if (!adminSecret) {
  console.error('ADMIN_SECRET is required to call /api/admin/audio/sfu/check.');
  process.exit(2);
}

let url;
try {
  url = new URL('/api/admin/audio/sfu/check', base);
} catch {
  console.error(`Invalid SFU check base URL: ${base}`);
  process.exit(2);
}

try {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${adminSecret}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ timeoutMs }),
  });
  const body = await res.json().catch(() => null);
  console.log(JSON.stringify(body ?? { ok: false, status: res.status }, null, 2));
  process.exit(res.ok && body?.ok === true ? 0 : 1);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
