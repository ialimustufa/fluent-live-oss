#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const env = { ...process.env };

// `verify` must be hermetic even when invoked from a production-like shell.
// Vite embeds VITE_* values and the asset CDN base into executable client
// URLs at build time, before either smoke harness can sanitize its child env.
for (const key of Object.keys(env)) {
  if (key.startsWith('VITE_')) env[key] = '';
}
env.ASSET_CDN_BASE_URL = '';
env.VITE_ASSET_CDN_BASE_URL = '';
env.VITE_GA_MEASUREMENT_ID = '';
env.VITE_AUDIO_SYNC_V2 = '';

const steps = [
  ['run', 'release:check'],
  ['run', 'typecheck'],
  ['run', 'build'],
  ['run', 'preflight:test'],
  ['audit'],
  ['run', 'smoke'],
  ['run', 'browser:smoke'],
];

for (const args of steps) {
  const result = spawnSync(npm, args, {
    env,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
