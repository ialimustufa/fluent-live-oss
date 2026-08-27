import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import type { Env } from './env.js';
import { generatedPdfPath, isGeneratedPdfUpload, removeUploadedPdf } from './uploads.js';

const R2_REF_PREFIX = 'r2:';
const CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4';
const CACHE_PURGE_TIMEOUT_MS = 10_000;
const CACHE_PURGE_PREFIXES_PER_REQUEST = 100;

interface CloudflarePurgeResult {
  success?: boolean;
  errors?: Array<{ code?: number; message?: string }>;
}

export interface SlideStorage {
  readonly mode: 'local' | 'r2';
  uploadPdf(tmpPath: string, key: string): Promise<string>;
  readPdf(file: string): Promise<{ body: NodeJS.ReadableStream; contentLength?: number } | null>;
  /** True when the object is gone (including already absent); false when cleanup must be retried. */
  remove(ref: string): Promise<boolean>;
  /** Batch cleanup, returning only refs whose object and every cache variant are gone. */
  removeMany(refs: string[]): Promise<Set<string>>;
  publicUrl(ref: string): string | null;
}

function r2ObjectKey(ref: string): string | null {
  if (!ref.startsWith(R2_REF_PREFIX)) return null;
  const key = ref.slice(R2_REF_PREFIX.length);
  const file = key.startsWith('slides/') ? key.slice('slides/'.length) : '';
  return file && isGeneratedPdfUpload(file) ? key : null;
}

function r2RefFile(ref: string): string | null {
  const key = r2ObjectKey(ref);
  const file = key?.startsWith('slides/') ? key.slice('slides/'.length) : null;
  return file && isGeneratedPdfUpload(file) ? file : null;
}

function encodeKeyPath(key: string): string {
  return key.split('/').map(encodeURIComponent).join('/');
}

function asNodeStream(body: unknown): NodeJS.ReadableStream | null {
  return body && typeof (body as { pipe?: unknown }).pipe === 'function'
    ? (body as NodeJS.ReadableStream)
    : null;
}

function r2Configured(env: Env): boolean {
  return Boolean(
    env.R2_ACCOUNT_ID &&
      env.R2_ACCESS_KEY_ID &&
      env.R2_SECRET_ACCESS_KEY &&
      env.R2_BUCKET
  );
}

export function createSlideStorage(env: Env): SlideStorage {
  if (!r2Configured(env)) {
    async function removeMany(refs: string[]): Promise<Set<string>> {
      const completed = new Set<string>();
      for (const ref of refs) {
        if (ref.startsWith(R2_REF_PREFIX)) {
          const reason = r2ObjectKey(ref)
            ? 'R2 storage is not configured'
            : 'the ref is outside the managed slides namespace';
          console.warn(`[storage] cannot remove queued R2 object: ${reason}`);
        } else if (!isGeneratedPdfUpload(ref)) {
          // External/legacy URLs have no managed object to remove.
          completed.add(ref);
        } else if (await removeUploadedPdf(env.UPLOADS_DIR, ref)) {
          completed.add(ref);
        }
      }
      return completed;
    }

    return {
      mode: 'local',
      async uploadPdf(tmpPath, key) {
        await fsp.mkdir(env.UPLOADS_DIR, { recursive: true });
        await fsp.rename(tmpPath, generatedPdfPath(env.UPLOADS_DIR, key));
        return key;
      },
      async readPdf(file) {
        if (!isGeneratedPdfUpload(file)) return null;
        const fullPath = generatedPdfPath(env.UPLOADS_DIR, file);
        try {
          const st = await fsp.stat(fullPath);
          if (!st.isFile()) return null;
          return { body: fs.createReadStream(fullPath), contentLength: st.size };
        } catch {
          return null;
        }
      },
      async remove(ref) {
        return (await removeMany([ref])).has(ref);
      },
      removeMany,
      publicUrl(ref) {
        if (!isGeneratedPdfUpload(ref)) return null;
        return `/uploads/${ref}`;
      },
    };
  }

  const bucket = env.R2_BUCKET!;
  const publicBase = env.R2_PUBLIC_BASE_URL?.replace(/\/+$/, '') ?? null;
  const cachePurgeBases = env.R2_CACHE_PURGE_BASE_URLS;
  const s3 = new S3Client({
    region: 'auto',
    endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: env.R2_ACCESS_KEY_ID!,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY!,
    },
  });

  async function purgePublicObjects(keys: string[]): Promise<Set<string>> {
    const purgedKeys = new Set<string>();
    if (keys.length === 0) return purgedKeys;
    if (cachePurgeBases.length === 0) return new Set(keys);
    if (!env.R2_CACHE_PURGE_ZONE_ID || !env.R2_CACHE_PURGE_API_TOKEN) {
      console.warn(
        `[storage] cannot verify deletion of ${keys.length} publicly served R2 object(s): ` +
          'R2_CACHE_PURGE_ZONE_ID and R2_CACHE_PURGE_API_TOKEN are not configured'
      );
      return purgedKeys;
    }

    // Keep every public base for a key in the same API request. That lets a
    // successful batch be acknowledged independently when a later batch is
    // rate-limited, so the next boot retries only unfinished keys.
    const keysPerBatch = Math.max(
      1,
      Math.floor(CACHE_PURGE_PREFIXES_PER_REQUEST / cachePurgeBases.length)
    );
    for (let offset = 0; offset < keys.length; offset += keysPerBatch) {
      const keyBatch = keys.slice(offset, offset + keysPerBatch);
      const prefixBatch = cachePurgeBases.flatMap((base) =>
        keyBatch.map((key) => {
          const publicUrl = new URL(`${base.replace(/\/+$/, '')}/${encodeKeyPath(key)}`);
          // Prefix purge removes every cache-key variant of this generated
          // filename, including arbitrary query strings and request headers.
          return `${publicUrl.host}${publicUrl.pathname}`;
        })
      );
      try {
        const response = await fetch(
          `${CLOUDFLARE_API_BASE}/zones/${encodeURIComponent(env.R2_CACHE_PURGE_ZONE_ID)}/purge_cache`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${env.R2_CACHE_PURGE_API_TOKEN}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ prefixes: prefixBatch }),
            signal: AbortSignal.timeout(CACHE_PURGE_TIMEOUT_MS),
          }
        );
        const result = await response.json().catch(() => null) as CloudflarePurgeResult | null;
        if (!response.ok || result?.success !== true) {
          const errors = result?.errors
            ?.map((error) => `${error.code ?? 'unknown'}: ${error.message ?? 'unknown error'}`)
            .join('; ');
          console.warn(
            `[storage] failed to purge ${prefixBatch.length} cached R2 prefix(es): ` +
              `${response.status}${errors ? ` (${errors})` : ''}`
          );
        } else {
          for (const key of keyBatch) purgedKeys.add(key);
        }
      } catch (err) {
        console.warn(`[storage] failed to purge ${prefixBatch.length} cached R2 prefix(es):`, err);
      }
    }
    return purgedKeys;
  }

  async function removeMany(refs: string[]): Promise<Set<string>> {
    const completed = new Set<string>();
    const r2RefsByKey = new Map<string, string[]>();
    for (const ref of refs) {
      if (ref.startsWith(R2_REF_PREFIX)) {
        const key = r2ObjectKey(ref);
        if (!key) {
          console.warn('[storage] refusing to remove queued R2 ref outside the managed slides namespace');
          continue;
        }
        const matchingRefs = r2RefsByKey.get(key) ?? [];
        matchingRefs.push(ref);
        r2RefsByKey.set(key, matchingRefs);
      } else if (!isGeneratedPdfUpload(ref)) {
        // External/legacy URLs have no managed object to remove.
        completed.add(ref);
      } else if (await removeUploadedPdf(env.UPLOADS_DIR, ref)) {
        completed.add(ref);
      }
    }

    const deletedKeys: string[] = [];
    for (const key of r2RefsByKey.keys()) {
      try {
        await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
        deletedKeys.push(key);
      } catch (err) {
        console.warn(`[storage] failed to remove R2 object ${key}:`, err);
      }
    }

    const purgedKeys = await purgePublicObjects(deletedKeys);
    for (const key of purgedKeys) {
      for (const ref of r2RefsByKey.get(key) ?? []) completed.add(ref);
    }
    return completed;
  }

  return {
    mode: 'r2',
    async uploadPdf(tmpPath, key) {
      if (!isGeneratedPdfUpload(key)) throw new Error(`invalid uploaded PDF key: ${key}`);
      const objectKey = `slides/${key}`;
      await s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: objectKey,
          Body: fs.createReadStream(tmpPath),
          ContentType: 'application/pdf',
          CacheControl: 'private, no-store, max-age=0',
        })
      );
      await fsp.unlink(tmpPath).catch(() => {});
      return `${R2_REF_PREFIX}${objectKey}`;
    },
    async readPdf(file) {
      if (!isGeneratedPdfUpload(file)) return null;
      try {
        const res = await s3.send(
          new GetObjectCommand({
            Bucket: bucket,
            Key: `slides/${file}`,
          })
        );
        const body = asNodeStream(res.Body);
        return body ? { body, contentLength: res.ContentLength } : null;
      } catch (err) {
        const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
        if (status !== 404) console.warn(`[storage] failed to read R2 object slides/${file}:`, err);
        return null;
      }
    },
    async remove(ref) {
      return (await removeMany([ref])).has(ref);
    },
    removeMany,
    publicUrl(ref) {
      const file = r2RefFile(ref);
      if (file) {
        return publicBase ? `${publicBase}/${encodeKeyPath(`slides/${file}`)}` : `/uploads/${file}`;
      }
      if (!isGeneratedPdfUpload(ref)) return null;
      return `/uploads/${ref}`;
    },
  };
}
