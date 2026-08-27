import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import type { Env } from './env.js';
import { generatedPdfPath, isGeneratedPdfUpload, removeUploadedPdf } from './uploads.js';

const R2_REF_PREFIX = 'r2:';

export interface SlideStorage {
  readonly mode: 'local' | 'r2';
  uploadPdf(tmpPath: string, key: string): Promise<string>;
  readPdf(file: string): Promise<{ body: NodeJS.ReadableStream; contentLength?: number } | null>;
  remove(ref: string): Promise<void>;
  publicUrl(ref: string): string | null;
}

function r2ObjectKey(ref: string): string | null {
  if (!ref.startsWith(R2_REF_PREFIX)) return null;
  const key = ref.slice(R2_REF_PREFIX.length);
  return key && !key.includes('..') ? key : null;
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
        await removeUploadedPdf(env.UPLOADS_DIR, ref);
      },
      publicUrl(ref) {
        if (!isGeneratedPdfUpload(ref)) return null;
        return `/uploads/${ref}`;
      },
    };
  }

  const bucket = env.R2_BUCKET!;
  const publicBase = env.R2_PUBLIC_BASE_URL?.replace(/\/+$/, '') ?? null;
  const s3 = new S3Client({
    region: 'auto',
    endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: env.R2_ACCESS_KEY_ID!,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY!,
    },
  });

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
          CacheControl: 'public, max-age=31536000, immutable',
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
      const key = r2ObjectKey(ref);
      if (key) {
        await s3
          .send(
            new DeleteObjectCommand({
              Bucket: bucket,
              Key: key,
            })
          )
          .catch((err) => {
            console.warn(`[storage] failed to remove R2 object ${key}:`, err);
          });
        return;
      }
      await removeUploadedPdf(env.UPLOADS_DIR, ref);
    },
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
