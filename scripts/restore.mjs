#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

for (const file of ['.env', path.join('server', '.env')]) {
  try {
    process.loadEnvFile(path.join(ROOT, file));
    break;
  } catch {
    /* no local env file */
  }
}

function argValue(name, fallback = undefined) {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return fallback;
  const value = process.argv[idx + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function positionalArgs() {
  const out = [];
  for (let i = 2; i < process.argv.length; i += 1) {
    const value = process.argv[i];
    if (value.startsWith('--')) {
      if (process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) i += 1;
    } else {
      out.push(value);
    }
  }
  return out;
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function exists(file) {
  try {
    await fsp.access(file);
    return true;
  } catch {
    return false;
  }
}

async function sha256(file) {
  const h = crypto.createHash('sha256');
  const stream = fs.createReadStream(file);
  for await (const chunk of stream) h.update(chunk);
  return h.digest('hex');
}

async function copyDir(src, dest) {
  await fsp.mkdir(dest, { recursive: true });
  try {
    const entries = await fsp.readdir(src, { withFileTypes: true });
    for (const ent of entries) {
      const from = path.join(src, ent.name);
      const to = path.join(dest, ent.name);
      if (ent.isDirectory()) await copyDir(from, to);
      else if (ent.isFile()) await fsp.copyFile(from, to);
    }
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') return;
    throw err;
  }
}

async function moveIfExists(src, dest) {
  if (!(await exists(src))) return false;
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  await fsp.rename(src, dest);
  return true;
}

async function main() {
  const backupArg = argValue('--backup', positionalArgs()[0]);
  if (!backupArg) throw new Error('usage: node scripts/restore.mjs --backup <dir> [--force]');
  const backupDir = path.resolve(backupArg);
  const databasePath = path.resolve(argValue('--database', process.env.DATABASE_PATH ?? path.join(ROOT, 'data', 'app.db')));
  const uploadsDir = path.resolve(argValue('--uploads', process.env.UPLOADS_DIR ?? path.join(ROOT, 'data', 'uploads')));
  const force = hasFlag('--force');

  const manifest = JSON.parse(await fsp.readFile(path.join(backupDir, 'manifest.json'), 'utf8'));
  const dbIn = path.join(backupDir, manifest.database?.file ?? 'app.db');
  if ((await sha256(dbIn)) !== manifest.database?.sha256) {
    throw new Error('backup database checksum mismatch');
  }

  const targetExists =
    (await exists(databasePath)) ||
    (await exists(`${databasePath}-wal`)) ||
    (await exists(`${databasePath}-shm`)) ||
    (await exists(uploadsDir));
  if (targetExists && !force) {
    throw new Error('target database/uploads already exist; pass --force to replace them with a safety copy');
  }

  const safetyDir = path.join(path.dirname(databasePath), `pre-restore-${timestamp()}`);
  if (force && targetExists) {
    await moveIfExists(databasePath, path.join(safetyDir, 'app.db'));
    await moveIfExists(`${databasePath}-wal`, path.join(safetyDir, 'app.db-wal'));
    await moveIfExists(`${databasePath}-shm`, path.join(safetyDir, 'app.db-shm'));
    await moveIfExists(uploadsDir, path.join(safetyDir, 'uploads'));
  }

  await fsp.mkdir(path.dirname(databasePath), { recursive: true });
  const tmpDb = `${databasePath}.restore-tmp`;
  await fsp.copyFile(dbIn, tmpDb);
  await fsp.rename(tmpDb, databasePath);

  await copyDir(path.join(backupDir, manifest.uploads?.dir ?? 'uploads'), uploadsDir);

  console.log(JSON.stringify({ ok: true, restoredDatabase: databasePath, restoredUploads: uploadsDir, safetyDir: targetExists ? safetyDir : null }));
}

main().catch((err) => {
  console.error(`restore failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
