/**
 * Resilient WS client for /ws/{slug}. Auto-reconnects with backoff and
 * re-sends the hello handshake on every (re)connect, so viewers' pages
 * survive server restarts (acceptance criterion #8).
 */
export interface WsEnvelope<T = unknown> {
  type: string;
  ts: number;
  seq: number;
  payload: T;
}

export type WsHandler = (msg: WsEnvelope) => void;

/**
 * Close codes that will recur the instant we reconnect, so retrying just tight-
 * loops: deliberate rejections (auth/forbidden/viewer-cap/rate-limit), plus
 * server-initiated terminal states (replaced host, deleted/unknown session).
 * Anything else (1006 abnormal, 1012 restart, 1013 overloaded, …) is transient
 * and worth a backoff retry.
 */
const NO_RETRY_CODES = new Set([4000, 4001, 4401, 4403, 4404, 4409, 4429]);
const MAX_RECONNECT_ATTEMPTS = 8;

export class SessionSocket {
  private ws: WebSocket | null = null;
  private closed = false;
  private retryMs = 1000;
  private attempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  onMessage: WsHandler = () => {};
  onStatusChange: (connected: boolean) => void = () => {};
  onClosed: (code: number, reason: string) => void = () => {};
  /** Fired once we stop retrying (terminal code or attempt ceiling). */
  onGaveUp: (code: number, reason: string) => void = () => {};

  constructor(
    private slug: string,
    private role: 'host' | 'viewer',
    private auth?: string,
    /** Extra fields merged into the hello payload (e.g. viewer onboarding id/name/company). */
    private helloExtra?: Record<string, unknown>
  ) {}

  connect(): void {
    this.closed = false;
    this.attempts = 0;
    this.retryMs = 1000;
    this.clearReconnectTimer();
    this.open();
  }

  private open(): void {
    if (this.closed) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws/${this.slug}`);
    this.ws = ws;

    ws.onopen = () => {
      this.clearReconnectTimer();
      this.retryMs = 1000;
      this.attempts = 0;
      this.onStatusChange(true);
      // Auth travels in the handshake message body, never the URL.
      this.send('hello', { role: this.role, auth: this.auth, ...(this.helloExtra ?? {}) });
    };
    ws.onmessage = (ev) => {
      try {
        this.onMessage(JSON.parse(ev.data));
      } catch {
        /* ignore malformed frames */
      }
    };
    ws.onclose = (ev) => {
      this.onStatusChange(false);
      this.onClosed(ev.code, ev.reason);
      if (this.closed) return;
      // Don't tight-loop on a code that will immediately recur, and don't retry
      // forever — give up (visibly) after a ceiling so failures aren't silent.
      if (NO_RETRY_CODES.has(ev.code) || this.attempts >= MAX_RECONNECT_ATTEMPTS) {
        console.warn(`[ws] giving up reconnect (code=${ev.code} reason=${ev.reason || '(none)'})`);
        this.onGaveUp(ev.code, ev.reason);
        return;
      }
      this.attempts += 1;
      console.warn(`[ws] reconnecting #${this.attempts} (code=${ev.code} reason=${ev.reason || '(none)'})`);
      this.clearReconnectTimer();
      // Capped exponential backoff with jitter so a herd of clients doesn't
      // reconnect in lockstep after a server blip.
      const jitter = Math.random() * 0.3 * this.retryMs;
      this.reconnectTimer = setTimeout(() => this.open(), this.retryMs + jitter);
      this.retryMs = Math.min(this.retryMs * 2, 10_000);
    };
    ws.onerror = () => ws.close();
  }

  send(type: string, payload: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type, ts: Date.now(), seq: 0, payload }));
    }
  }

  close(): void {
    this.closed = true;
    this.clearReconnectTimer();
    this.ws?.close();
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}
