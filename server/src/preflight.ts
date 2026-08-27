import Database from 'better-sqlite3';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initDb } from './db.js';
import { loadEnv } from './env.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function assertWritableDir(dir: string, label: string): Promise<void> {
  await fsp.mkdir(dir, { recursive: true });
  const probe = path.join(dir, `.preflight-${process.pid}-${Date.now()}`);
  await fsp.writeFile(probe, 'ok');
  await fsp.unlink(probe);
  console.log(`ok ${label}: writable (${dir})`);
}

async function assertClientBuild(): Promise<void> {
  const clientDist = path.resolve(__dirname, '../../client/dist');
  const indexPath = path.join(clientDist, 'index.html');
  const assetsPath = path.join(clientDist, 'assets');
  await fsp.access(indexPath, fs.constants.R_OK);
  const assets = await fsp.readdir(assetsPath);
  if (!assets.some((f) => /^index-.*\.js$/.test(f))) {
    throw new Error(`client build is missing the main JS chunk in ${assetsPath}`);
  }
  console.log(`ok client build: ${clientDist}`);
}

async function assertDbBackup(databasePath: string): Promise<void> {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'fluent-preflight-'));
  const backupPath = path.join(tmpDir, 'app.db');
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const integrity = db.prepare('PRAGMA integrity_check').get() as { integrity_check?: string };
    if (integrity.integrity_check !== 'ok') {
      throw new Error(`SQLite integrity_check failed: ${integrity.integrity_check ?? '(no result)'}`);
    }
    await db.backup(backupPath);
    const st = await fsp.stat(backupPath);
    if (!st.isFile() || st.size <= 0) throw new Error('SQLite backup produced an empty file');
  } finally {
    db.close();
    await fsp.rm(tmpDir, { recursive: true, force: true });
  }
  console.log('ok database: integrity_check + backup');
}

async function main(): Promise<void> {
  const env = loadEnv();
  await assertClientBuild();
  await assertWritableDir(path.dirname(env.DATABASE_PATH), 'database directory');
  await assertWritableDir(env.UPLOADS_DIR, 'uploads directory');
  initDb(env.DATABASE_PATH);
  await assertDbBackup(env.DATABASE_PATH);
  if (process.env.NODE_ENV === 'production' && !env.PUBLIC_ORIGIN) {
    console.warn('warning PUBLIC_ORIGIN is not set; same-host HTML decks are still rejected from request Host.');
  }
  console.log(JSON.stringify({
    ok: true,
    databasePath: env.DATABASE_PATH,
    uploadsDir: env.UPLOADS_DIR,
    port: env.PORT,
    trustProxy: env.TRUST_PROXY,
    publicOrigin: env.PUBLIC_ORIGIN,
  }));
}

main().catch((err) => {
  console.error(`preflight failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
