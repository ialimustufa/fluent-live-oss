#!/usr/bin/env node
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const ASSETS_DIR = path.join(ROOT, 'client', 'dist', 'assets');

for (const file of ['.env', path.join('server', '.env')]) {
  try {
    process.loadEnvFile(path.join(ROOT, file));
    break;
  } catch {
    /* no local env file */
  }
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function contentType(file) {
  if (file.endsWith('.js') || file.endsWith('.mjs')) return 'text/javascript; charset=utf-8';
  if (file.endsWith('.css')) return 'text/css; charset=utf-8';
  if (file.endsWith('.svg')) return 'image/svg+xml';
  if (file.endsWith('.png')) return 'image/png';
  if (file.endsWith('.jpg') || file.endsWith('.jpeg')) return 'image/jpeg';
  if (file.endsWith('.webp')) return 'image/webp';
  if (file.endsWith('.woff2')) return 'font/woff2';
  return 'application/octet-stream';
}

async function* walk(dir) {
  for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile()) yield full;
  }
}

async function main() {
  const assetBase = (process.env.ASSET_CDN_BASE_URL || process.env.VITE_ASSET_CDN_BASE_URL || '').trim();
  if (!assetBase) {
    console.log('ASSET_CDN_BASE_URL is not set; skipping CDN asset upload.');
    return;
  }

  await fsp.access(ASSETS_DIR, fs.constants.R_OK);

  const accountId = required('R2_ACCOUNT_ID');
  const bucket = required('R2_BUCKET');
  const s3 = new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: required('R2_ACCESS_KEY_ID'),
      secretAccessKey: required('R2_SECRET_ACCESS_KEY'),
    },
  });

  let count = 0;
  let bytes = 0;
  for await (const file of walk(ASSETS_DIR)) {
    const rel = path.relative(path.join(ROOT, 'client', 'dist'), file).split(path.sep).join('/');
    const st = await fsp.stat(file);
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: rel,
        Body: fs.createReadStream(file),
        ContentType: contentType(file),
        CacheControl: 'public, max-age=31536000, immutable',
      })
    );
    count += 1;
    bytes += st.size;
    console.log(`uploaded ${rel}`);
  }

  console.log(JSON.stringify({ ok: true, count, bytes }));
}

main().catch((err) => {
  console.error(`upload-assets-to-r2 failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
