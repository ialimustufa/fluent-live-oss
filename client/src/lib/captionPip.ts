import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Document Picture-in-Picture caption window (Chrome/Edge). Opens an
 * always-on-top floating window the presenter can place over their NATIVE
 * slides/Zoom; it's captured when sharing the whole screen. The caller portals
 * a caption component into `container`.
 */

interface DocumentPiP {
  requestWindow: (opts?: { width?: number; height?: number }) => Promise<Window>;
}

function getDpip(): DocumentPiP | undefined {
  return (window as unknown as { documentPictureInPicture?: DocumentPiP }).documentPictureInPicture;
}

/** Clone the page's stylesheets into the PiP document so Tailwind applies. */
function copyStyles(win: Window): void {
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      const css = Array.from(sheet.cssRules)
        .map((r) => r.cssText)
        .join('');
      const style = win.document.createElement('style');
      style.textContent = css;
      win.document.head.appendChild(style);
    } catch {
      // Cross-origin sheet: cssRules throws — link it by href instead.
      if (sheet.href) {
        const link = win.document.createElement('link');
        link.rel = 'stylesheet';
        link.href = sheet.href;
        win.document.head.appendChild(link);
      }
    }
  }
}

export function useCaptionPip() {
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const winRef = useRef<Window | null>(null);
  const supported = typeof window !== 'undefined' && !!getDpip();

  // Must be called from a user gesture (requestWindow needs user activation).
  const open = useCallback(async () => {
    const dpip = getDpip();
    if (!dpip || winRef.current) return;
    let win: Window;
    try {
      win = await dpip.requestWindow({ width: 600, height: 200 });
    } catch {
      return;
    }
    winRef.current = win;
    copyStyles(win);
    win.document.body.style.margin = '0';
    win.document.body.style.background = '#07090f';
    const div = win.document.createElement('div');
    div.style.height = '100vh';
    win.document.body.appendChild(div);
    win.addEventListener('pagehide', () => {
      winRef.current = null;
      setContainer(null);
    });
    setContainer(div);
  }, []);

  const close = useCallback(() => {
    winRef.current?.close();
    winRef.current = null;
    setContainer(null);
  }, []);

  useEffect(() => () => winRef.current?.close(), []);

  return { supported, open, close, container, isOpen: !!container };
}
