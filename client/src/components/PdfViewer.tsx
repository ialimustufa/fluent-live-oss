import { useEffect, useRef, useState } from 'react';
import * as pdfjs from 'pdfjs-dist';
import type { PDFDocumentProxy } from 'pdfjs-dist';

const pdfWorkerAssetUrl = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url
).toString();

pdfjs.GlobalWorkerOptions.workerSrc =
  typeof window === 'undefined'
    ? pdfWorkerAssetUrl
    : `${window.location.origin}${new URL(pdfWorkerAssetUrl).pathname}`;

interface Props {
  url: string;
  pageIndex: number; // 0-based
  onPageCount?: (n: number) => void;
}

function appUploadFallbackUrl(url: string): string | null {
  try {
    const parsed = new URL(url, window.location.href);
    if (parsed.origin === window.location.origin) return null;
    const file = parsed.pathname.split('/').pop() ?? '';
    return /^[A-Za-z0-9_-]{12}\.pdf$/.test(file) ? `/uploads/${file}` : null;
  } catch {
    return null;
  }
}

async function fetchPdfBytes(url: string, signal: AbortSignal): Promise<ArrayBuffer> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`PDF HTTP ${res.status}`);
  const data = await res.arrayBuffer();
  const head = String.fromCharCode(...new Uint8Array(data, 0, Math.min(1024, data.byteLength)));
  if (!head.includes('%PDF-')) {
    throw new Error('Slide file is not a PDF. Check the uploaded file or CDN/R2 public URL.');
  }
  return data;
}

export default function PdfViewer({ url, pageIndex, onPageCount }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const renderTaskRef = useRef<{ cancel: () => void } | null>(null);

  useEffect(() => {
    let disposed = false;
    let loadedDoc: PDFDocumentProxy | null = null;
    let loadingTask: ReturnType<typeof pdfjs.getDocument> | null = null;
    const controller = new AbortController();

    renderTaskRef.current?.cancel();
    renderTaskRef.current = null;
    setDoc(null);
    setError(null);

    void (async () => {
      try {
        let data: ArrayBuffer;
        try {
          data = await fetchPdfBytes(url, controller.signal);
        } catch (err) {
          const fallbackUrl = appUploadFallbackUrl(url);
          if (!fallbackUrl) throw err;
          console.warn('[pdf] CDN fetch failed; retrying through app /uploads proxy.', err);
          data = await fetchPdfBytes(fallbackUrl, controller.signal);
        }
        if (disposed) return;

        loadingTask = pdfjs.getDocument({
          data: new Uint8Array(data),
          verbosity: pdfjs.VerbosityLevel.ERRORS,
        });
        const d = await loadingTask.promise;
        if (disposed) {
          void d.destroy();
          return;
        }
        loadedDoc = d;
        setDoc(d);
        onPageCount?.(d.numPages);
      } catch (e) {
        if (!disposed && !(e instanceof DOMException && e.name === 'AbortError')) {
          setError(String(e instanceof Error ? e.message : e));
        }
      }
    })();

    return () => {
      disposed = true;
      controller.abort();
      renderTaskRef.current?.cancel();
      renderTaskRef.current = null;
      if (loadedDoc) {
        void loadedDoc.destroy();
        loadedDoc = null;
      } else {
        void loadingTask?.destroy().catch(() => {});
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  useEffect(() => {
    if (!doc || !canvasRef.current || !containerRef.current) return;
    const pageNum = Math.min(Math.max(pageIndex + 1, 1), doc.numPages);
    let cancelled = false;

    void doc.getPage(pageNum).then((page) => {
      if (cancelled || !canvasRef.current || !containerRef.current) return;
      const container = containerRef.current;
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(
        container.clientWidth / base.width,
        container.clientHeight / base.height
      );
      const dpr = window.devicePixelRatio || 1;
      const viewport = page.getViewport({ scale: scale * dpr });

      const canvas = canvasRef.current;
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      canvas.style.width = `${viewport.width / dpr}px`;
      canvas.style.height = `${viewport.height / dpr}px`;

      renderTaskRef.current?.cancel();
      const task = page.render({
        canvasContext: canvas.getContext('2d')!,
        viewport,
      });
      renderTaskRef.current = task;
      task.promise.catch(() => {
        /* cancelled renders throw; ignore */
      });
    });

    // Preload adjacent pages so prev/next is instant.
    for (const adj of [pageNum - 1, pageNum + 1]) {
      if (adj >= 1 && adj <= doc.numPages) void doc.getPage(adj);
    }

    return () => {
      cancelled = true;
      renderTaskRef.current?.cancel();
      renderTaskRef.current = null;
    };
  }, [doc, pageIndex]);

  if (error) {
    return <div className="flex h-full items-center justify-center text-red-400">{error}</div>;
  }

  return (
    <div ref={containerRef} className="flex h-full w-full items-center justify-center">
      <canvas ref={canvasRef} className="max-h-full max-w-full shadow-lg" />
    </div>
  );
}
