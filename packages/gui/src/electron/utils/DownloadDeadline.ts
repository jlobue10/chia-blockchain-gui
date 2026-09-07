// The default is the video-sized ceiling used by downloadFile. A caller can
// only shorten it: IPC values must never disable a deadline or overflow timers.
export const DEFAULT_DOWNLOAD_MAX_DURATION = 30 * 60 * 1000;

export function normalizeDownloadDuration(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_DOWNLOAD_MAX_DURATION;
  }
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error('Download duration must be a positive finite number');
  }
  return Math.max(1, Math.min(Math.floor(value), DEFAULT_DOWNLOAD_MAX_DURATION));
}

/** One deadline for a shared URL transfer, starting only on limiter admission.
 * Coalesced callers use the strictest duration, measured from the ORIGINAL
 * start, so joining an old video-sized request cannot bypass a metadata cap.
 * Expiry aborts the real transfer; it is not a Promise.race that leaks a slot.
 */
export default class DownloadDeadline {
  private duration: number;

  private startedAt: number | undefined;

  private finishedAt: number | undefined;

  private timer: ReturnType<typeof setTimeout> | undefined;

  public error: Error | undefined;

  constructor(
    duration: number | undefined,
    private readonly abort: () => void,
  ) {
    this.duration = normalizeDownloadDuration(duration);
  }

  constrain(duration: number | undefined) {
    this.duration = Math.min(this.duration, normalizeDownloadDuration(duration));
    if (this.startedAt !== undefined && !this.error) {
      this.schedule();
    }
  }

  private startWaiters: (() => void)[] = [];

  start() {
    if (this.startedAt === undefined) {
      this.startedAt = Date.now();
      this.schedule();
      const waiters = this.startWaiters;
      this.startWaiters = [];
      waiters.forEach((resolve) => resolve());
    }
  }

  /** Resolves once the transfer has been admitted and its clock is running;
   * at once if it already has. Lets a caller that shares the transfer wait
   * out the queue, which no allowance is charged for, before its own clock
   * starts. */
  whenStarted(): Promise<void> {
    if (this.startedAt !== undefined) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.startWaiters.push(resolve);
    });
  }

  remaining(): number {
    this.throwIfExpired();
    return this.startedAt === undefined ? this.duration : Math.max(1, this.duration - (Date.now() - this.startedAt));
  }

  throwIfExpired() {
    if (this.startedAt !== undefined && Date.now() - this.startedAt >= this.duration) {
      this.expire();
    }
    if (this.error) {
      throw this.error;
    }
  }

  dispose() {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  finish() {
    this.finishedAt = Date.now();
    this.dispose();
  }

  elapsed(): number {
    return this.startedAt === undefined ? 0 : Math.max(0, (this.finishedAt ?? Date.now()) - this.startedAt);
  }

  private expire() {
    this.dispose();
    if (!this.error) {
      // Preserve the existing timeout classifier/sidecar contract. An ordinary
      // "Request aborted" would instead be retried on every next tile access.
      this.error = new Error(`Request exceeded the ${this.duration}ms download deadline`);
      this.abort();
    }
  }

  private schedule() {
    this.dispose();
    const remaining = this.duration - (Date.now() - this.startedAt!);
    if (remaining <= 0) {
      this.expire();
    } else {
      this.timer = setTimeout(() => this.expire(), remaining);
    }
  }
}
