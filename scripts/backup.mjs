#!/usr/bin/env node
import Database from 'better-sqlite3';
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

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function sha256(file) {
  const h = crypto.createHash('sha256');
  const stream = fs.createReadStream(file);
  for await (const chunk of stream) h.update(chunk);
  return h.digest('hex');
}

async function copyUploads(src, dest) {
  const copied = [];
  try {
    const st = await fsp.stat(src);
    if (!st.isDirectory()) return copied;
  } catch {
    return copied;
  }

  async function walk(dir) {
    for (const ent of await fsp.readdir(dir, { withFileTypes: true })) {
      const abs = path.join(dir, ent.name);
      const rel = path.relative(src, abs);
      if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
      if (ent.isDirectory()) {
        await walk(abs);
      } else if (ent.isFile() && !ent.name.startsWith('.')) {
        const out = path.join(dest, rel);
        await fsp.mkdir(path.dirname(out), { recursive: true });
        await fsp.copyFile(abs, out);
        const st = await fsp.stat(out);
        copied.push({ path: rel, bytes: st.size, sha256: await sha256(out) });
      }
    }
  }

  await walk(src);
  copied.sort((a, b) => a.path.localeCompare(b.path));
  return copied;
}

async function main() {
  const databasePath = path.resolve(argValue('--database', process.env.DATABASE_PATH ?? path.join(ROOT, 'data', 'app.db')));
  const uploadsDir = path.resolve(argValue('--uploads', process.env.UPLOADS_DIR ?? path.join(ROOT, 'data', 'uploads')));
  const outDir = path.resolve(argValue('--out', path.join(ROOT, 'data', 'backups', timestamp())));

  await fsp.mkdir(outDir, { recursive: true });
  const dbOutTmp = path.join(outDir, 'app.db.tmp');
  const dbOut = path.join(outDir, 'app.db');

  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    await db.backup(dbOutTmp);
  } finally {
    db.close();
  }
  await fsp.rename(dbOutTmp, dbOut);

  const uploadsOut = path.join(outDir, 'uploads');
  const uploads = await copyUploads(uploadsDir, uploadsOut);
  const dbStat = await fsp.stat(dbOut);
  const manifest = {
    version: 1,
    createdAt: new Date().toISOString(),
    source: { databasePath, uploadsDir },
    database: { file: 'app.db', bytes: dbStat.size, sha256: await sha256(dbOut) },
    uploads: {
      dir: 'uploads',
      count: uploads.length,
      bytes: uploads.reduce((sum, f) => sum + f.bytes, 0),
      files: uploads,
    },
  };

  await fsp.writeFile(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(JSON.stringify({ ok: true, backupDir: outDir, databaseBytes: manifest.database.bytes, uploadCount: uploads.length }));
}

main().catch((err) => {
  console.error(`backup failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
