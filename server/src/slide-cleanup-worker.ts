import type { FastifyBaseLogger } from 'fastify';
import {
  completePendingSlideDeletion,
  listPendingSlideDeletions,
  preparePendingSlideDeletion,
} from './db.js';
import type { SlideStorage } from './storage.js';

const DEFAULT_RETRY_MS = 30_000;

/**
 * Best-effort durable object cleanup. Database rows are authoritative: storage
 * failures leave work queued and can never hold application readiness hostage.
 */
export class SlideCleanupWorker {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private started = false;
  private stopped = false;
  private rerunRequested = false;

  constructor(
    private readonly storage: SlideStorage,
    private readonly logger: Pick<FastifyBaseLogger, 'info' | 'warn'>,
    private readonly retryMs = DEFAULT_RETRY_MS
  ) {}

  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    this.rerunRequested = false;
    this.trigger();
  }

  /** Request an immediate pass without ever overlapping the active pass. */
  wake(): void {
    if (this.stopped) return;
    if (!this.started) {
      this.rerunRequested = true;
      return;
    }
    this.trigger();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.running;
  }

  private trigger(): void {
    if (!this.started || this.stopped) return;
    if (this.running) {
      this.rerunRequested = true;
      return;
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;

    this.running = this.drain()
      .catch((err) => {
        this.logger.warn({ err }, 'pending slide cleanup pass failed; work remains queued');
      })
      .finally(() => {
        this.running = null;
        if (this.stopped) return;
        if (this.rerunRequested) {
          this.rerunRequested = false;
          queueMicrotask(() => this.trigger());
          return;
        }
        this.timer = setTimeout(() => this.trigger(), this.retryMs);
        this.timer.unref?.();
      });
  }

  private async drain(): Promise<void> {
    const pending = listPendingSlideDeletions();
    if (pending.length === 0) return;

    // Recheck after reading the queue. A deck may have been attached to a
    // retained/new session since it was first queued.
    const eligible = pending.filter((slideRef) => preparePendingSlideDeletion(slideRef));
    if (eligible.length === 0) return;

    const removed = await this.storage.removeMany(eligible);
    let completed = 0;
    for (const slideRef of eligible) {
      if (!removed.has(slideRef)) continue;
      completePendingSlideDeletion(slideRef);
      completed += 1;
    }

    const remaining = eligible.length - completed;
    if (completed > 0) {
      this.logger.info({ completed, remaining }, 'processed pending slide cleanup');
    }
    if (remaining > 0) {
      this.logger.warn(
        { pending: remaining },
        'pending slide cleanup is degraded; retry scheduled'
      );
    }
  }
}
