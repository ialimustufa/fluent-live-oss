import { lazy, Suspense, useEffect, useMemo, useRef } from 'react';

const PdfViewer = lazy(() => import('./PdfViewer'));

interface Props {
  slideType: 'pdf' | 'gslides' | 'html';
  slideUrl: string;
  slideIndex: number; // 0-based
  onSlideCount?: (n: number) => void;
}

function gslidesEmbedUrl(url: string, slideIndex: number): string {
  // Published decks: /presentation/d/e/{pubId}/...; regular: /presentation/d/{id}/...
  const m = /\/presentation\/(d\/e\/[\w-]+|d\/[\w-]+)/.exec(url);
  const idPath = m ? m[1] : null;
  const base = idPath
    ? `https://docs.google.com/presentation/${idPath}/embed`
    : url.replace(/\/(pub|edit|view|present).*$/, '/embed');
  return `${base}?start=false&loop=false&rm=minimal&slide=${slideIndex + 1}`;
}

function htmlDeckOrigin(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

export default function SlideViewer({ slideType, slideUrl, slideIndex, onSlideCount }: Props) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const htmlTargetOrigin = useMemo(
    () => (slideType === 'html' ? htmlDeckOrigin(slideUrl) : null),
    [slideType, slideUrl]
  );

  // HTML decks: postMessage protocol — parent sends {type:'goto', index},
  // deck replies {type:'slideCount', n} (spec §5.3).
  useEffect(() => {
    if (slideType !== 'html') return;
    const onMsg = (ev: MessageEvent) => {
      if (!htmlTargetOrigin || ev.origin !== htmlTargetOrigin) return;
      if (ev.data?.type === 'slideCount' && typeof ev.data.n === 'number') {
        onSlideCount?.(ev.data.n);
      }
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, [slideType, htmlTargetOrigin, onSlideCount]);

  useEffect(() => {
    if (slideType !== 'html' || !htmlTargetOrigin || !iframeRef.current?.contentWindow) return;
    const win = iframeRef.current.contentWindow;
    win.postMessage({ type: 'goto', index: slideIndex }, htmlTargetOrigin);
    // Fallback for same-origin decks that don't implement the protocol:
    // forward arrow-key events. Cross-origin access throws; that's the
    // documented limitation for external URLs.
    try {
      const doc = win.document;
      doc.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })
      );
    } catch {
      /* cross-origin deck — postMessage only */
    }
  }, [slideType, htmlTargetOrigin, slideIndex]);

  if (slideType === 'pdf') {
    return (
      <Suspense
        fallback={
          <div className="flex h-full w-full items-center justify-center bg-[var(--surface-2)] text-sm text-[var(--faint)]">
            Loading…
          </div>
        }
      >
        <PdfViewer url={slideUrl} pageIndex={slideIndex} onPageCount={onSlideCount} />
      </Suspense>
    );
  }

  if (slideType === 'gslides') {
    // No postMessage control over cross-origin Slides embeds: sync by swapping
    // the iframe src. Visible reload flicker is a documented caveat (§5.2).
    return (
      <iframe
        key={slideIndex}
        title="slides"
        src={gslidesEmbedUrl(slideUrl, slideIndex)}
        className="h-full w-full border-0"
        allowFullScreen
      />
    );
  }

  return (
    <iframe
      ref={iframeRef}
      title="slides"
      src={slideUrl}
      className="h-full w-full border-0 bg-white"
      sandbox="allow-scripts allow-same-origin"
    />
  );
}
