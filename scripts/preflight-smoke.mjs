#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const ROOT = path.resolve(import.meta.dirname, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluent-preflight-smoke-'));
const databasePath = path.join(tempDir, 'app.db');
const uploadsDir = path.join(tempDir, 'uploads');

function digest(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function snapshotFile(file) {
  if (!fs.existsSync(file)) return null;
  const stat = fs.statSync(file);
  return { size: stat.size, mtimeMs: stat.mtimeMs, sha256: digest(file) };
}

function snapshotTree(dir) {
  const result = {};
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile()) result[path.relative(dir, absolute)] = snapshotFile(absolute);
    }
  };
  walk(dir);
  return result;
}

function snapshotFixture() {
  return {
    database: snapshotFile(databasePath),
    wal: snapshotFile(`${databasePath}-wal`),
    shm: snapshotFile(`${databasePath}-shm`),
    uploads: snapshotTree(uploadsDir),
  };
}

function stableSourceState(snapshot) {
  return {
    database: snapshot.database,
    wal: snapshot.wal,
    // SQLite may update lock bytes in the transient shared-memory sidecar
    // while taking a readonly online backup. Its existence/shape must remain
    // stable; persistent DB/WAL content and uploads must be byte-identical.
    shm: snapshot.shm && { size: snapshot.shm.size },
    uploads: snapshot.uploads,
  };
}

function sanitizedEnv(overrides = {}) {
  return {
    ...process.env,
    NODE_ENV: 'test',
    HOST: '127.0.0.1',
    ADMIN_SECRET: 'preflight-smoke-secret',
    GEMINI_API_KEY: 'preflight-smoke-key',
    DATABASE_PATH: databasePath,
    UPLOADS_DIR: uploadsDir,
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
    ...overrides,
  };
}

function runPreflight(args = [], envOverrides = {}) {
  return spawnSync('node', [path.join(ROOT, 'server/dist/preflight.js'), ...args], {
    cwd: ROOT,
    env: sanitizedEnv(envOverrides),
    encoding: 'utf8',
  });
}

function assertFailure(result, expectedMessage, label) {
  if (result.status === 0 || !result.stderr.includes(expectedMessage)) {
    throw new Error(
      `${label} should fail with ${JSON.stringify(expectedMessage)}\n${result.stdout}\n${result.stderr}`
    );
  }
}

let database;
try {
  fs.mkdirSync(uploadsDir, { recursive: true });
  fs.writeFileSync(path.join(uploadsDir, 'fixture.pdf'), 'preflight must not touch uploads');

  const { initDb } = await import(path.join(ROOT, 'server/dist/db.js'));
  initDb(databasePath).database.close();
  database = new Database(databasePath);
  database.pragma('journal_mode = WAL');
  database.exec(`
    ALTER TABLE sessions ADD COLUMN is_trial INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE sessions ADD COLUMN trial_type TEXT;
    CREATE TABLE beta_leads (id INTEGER PRIMARY KEY, email TEXT NOT NULL);
    INSERT INTO beta_leads (email) VALUES ('must-not-leak@example.invalid');
    INSERT INTO sessions (
      slug, title, target_lang, slide_type, slide_ref, slide_count,
      echo_target_language, state, peak_viewers, presentation_mode, is_trial, trial_type
    ) VALUES (
      'retired-fixture', 'Retired fixture', 'es', 'pdf', 'aaaaaaaaaaaa.pdf', 1,
      0, 'created', 0, 'in_person', 1, 'beta'
    );
    INSERT INTO pending_slide_deletions (slide_ref) VALUES ('bbbbbbbbbbbb.pdf');
    INSERT INTO database_maintenance_tasks (task) VALUES ('retired_public_data_compaction');
  `);

  const before = snapshotFixture();
  const result = runPreflight();
  const after = snapshotFixture();
  if (result.status !== 0) {
    throw new Error(`preflight failed\n${result.stdout}\n${result.stderr}`);
  }
  if (JSON.stringify(stableSourceState(before)) !== JSON.stringify(stableSourceState(after))) {
    throw new Error(`preflight mutated the source fixture\nbefore=${JSON.stringify(before)}\nafter=${JSON.stringify(after)}`);
  }
  if (!result.stdout.includes('"legacyMigrationRequired":true') ||
      !result.stdout.includes('"pendingSlideDeletionCount":1') ||
      !result.stdout.includes('"pendingCompactionCount":1')) {
    throw new Error(`preflight did not report expected maintenance state\n${result.stdout}`);
  }

  const strict = runPreflight(['--strict-current']);
  const afterStrict = snapshotFixture();
  if (strict.status === 0 || !strict.stderr.includes('strict current-state check failed')) {
    throw new Error(`strict preflight should reject outstanding maintenance\n${strict.stdout}\n${strict.stderr}`);
  }
  if (JSON.stringify(stableSourceState(before)) !== JSON.stringify(stableSourceState(afterStrict))) {
    throw new Error('strict preflight mutated the source fixture');
  }

  const currentPath = path.join(tempDir, 'current.db');
  initDb(currentPath).database.close();
  const currentBefore = snapshotFile(currentPath);
  const strictCurrent = runPreflight(['--strict-current'], { DATABASE_PATH: currentPath });
  if (
    strictCurrent.status !== 0 ||
    !strictCurrent.stdout.includes('"strictCurrent":true') ||
    !strictCurrent.stdout.includes('"legacyMigrationRequired":false') ||
    !strictCurrent.stdout.includes('"pendingSlideDeletionCount":0') ||
    !strictCurrent.stdout.includes('"pendingCompactionCount":0')
  ) {
    throw new Error(`strict preflight should accept a current database\n${strictCurrent.stdout}\n${strictCurrent.stderr}`);
  }
  const currentAfter = snapshotFile(currentPath);
  if (JSON.stringify(currentBefore) !== JSON.stringify(currentAfter)) {
    throw new Error('strict preflight mutated the current database fixture');
  }

  const missingPath = path.join(tempDir, 'missing.db');
  const missing = runPreflight([], { DATABASE_PATH: missingPath });
  assertFailure(missing, 'database does not exist', 'missing-database preflight');
  if (fs.existsSync(missingPath)) throw new Error('preflight created a missing production database');

  const missingUploads = path.join(tempDir, 'missing-uploads');
  const withoutUploads = runPreflight([], {
    DATABASE_PATH: currentPath,
    UPLOADS_DIR: missingUploads,
  });
  assertFailure(withoutUploads, 'uploads directory does not exist', 'missing-uploads preflight');
  if (fs.existsSync(missingUploads)) throw new Error('preflight created a missing uploads directory');

  const corruptPath = path.join(tempDir, 'corrupt.db');
  fs.writeFileSync(corruptPath, 'not a sqlite database');
  const corruptBefore = snapshotFile(corruptPath);
  const corrupt = runPreflight([], { DATABASE_PATH: corruptPath });
  if (corrupt.status === 0 || !/database|sqlite/i.test(corrupt.stderr)) {
    throw new Error(`corrupt-database preflight should fail clearly\n${corrupt.stdout}\n${corrupt.stderr}`);
  }
  if (JSON.stringify(corruptBefore) !== JSON.stringify(snapshotFile(corruptPath))) {
    throw new Error('preflight mutated the corrupt source fixture');
  }

  const readonlyDir = path.join(tempDir, 'readonly-source');
  const readonlyPath = path.join(readonlyDir, 'app.db');
  const readonlyUploads = path.join(readonlyDir, 'uploads');
  fs.mkdirSync(readonlyUploads, { recursive: true });
  fs.writeFileSync(path.join(readonlyUploads, 'fixture.pdf'), 'readonly upload fixture');
  initDb(readonlyPath).database.close();
  const readonlyBefore = {
    database: snapshotFile(readonlyPath),
    uploads: snapshotTree(readonlyUploads),
  };
  fs.chmodSync(readonlyPath, 0o444);
  fs.chmodSync(readonlyUploads, 0o555);
  fs.chmodSync(readonlyDir, 0o555);
  try {
    const readonly = runPreflight(['--strict-current'], {
      DATABASE_PATH: readonlyPath,
      UPLOADS_DIR: readonlyUploads,
    });
    if (readonly.status !== 0) {
      throw new Error(`read-only source preflight failed\n${readonly.stdout}\n${readonly.stderr}`);
    }
    const readonlyAfter = {
      database: snapshotFile(readonlyPath),
      uploads: snapshotTree(readonlyUploads),
    };
    if (JSON.stringify(readonlyBefore) !== JSON.stringify(readonlyAfter)) {
      throw new Error('preflight mutated a read-only source fixture');
    }
  } finally {
    fs.chmodSync(readonlyDir, 0o755);
    fs.chmodSync(readonlyUploads, 0o755);
    fs.chmodSync(readonlyPath, 0o644);
  }

  console.log(
    'ok preflight is read-only across legacy/current, strict, missing, corrupt, and readonly fixtures'
  );
} finally {
  database?.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
}
