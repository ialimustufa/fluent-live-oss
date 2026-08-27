import fsp from 'node:fs/promises';
import path from 'node:path';

export const GENERATED_PDF_RE = /^[A-Za-z0-9_-]{12}\.pdf$/;

export function isGeneratedPdfUpload(ref: string): boolean {
  return GENERATED_PDF_RE.test(ref);
}

export function generatedPdfPath(uploadsDir: string, ref: string): string {
  if (!isGeneratedPdfUpload(ref)) throw new Error(`invalid uploaded PDF ref: ${ref}`);
  return path.join(uploadsDir, ref);
}

export async function removeUploadedPdf(uploadsDir: string, ref: string): Promise<void> {
  if (!isGeneratedPdfUpload(ref)) return;
  await fsp.unlink(generatedPdfPath(uploadsDir, ref)).catch(() => {});
}
