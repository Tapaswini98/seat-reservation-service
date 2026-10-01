import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { loadConfig } from '../config/configuration';
import { log } from '../common/logging/logger';
import { MetricsService } from '../metrics/metrics.service';
import { IdempotencyService } from './idempotency.service';
import { ReservationsRepository } from './reservations.repository';

/**
 * Releases holds whose TTL has passed, and reaps idempotency keys past theirs.
 *
 * Deliberately a plain interval rather than a cron: the tick is short and the
 * work is bounded per pass, so a slow database degrades into "expiry is a bit
 * late" instead of "overlapping sweeps pile up on the pool". A re-entrancy
 * guard enforces that -- one sweep at a time per instance, and SKIP LOCKED in
 * the query itself handles more than one instance.
 */
@Injectable()
export class ExpiryService implements OnModuleInit, OnModuleDestroy {
  private readonly cfg = loadConfig();
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private ticksSincePurge = 0;

  constructor(
    private readonly repo: ReservationsRepository,
    private readonly idempotency: IdempotencyService,
    private readonly metrics: MetricsService,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(
      () => void this.tick(),
      this.cfg.resilience.expirySweepIntervalMs,
    );
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const result = await this.repo.sweepExpiredHolds(
        this.cfg.resilience.expirySweepBatch,
      );
      if (result.reservations > 0) {
        this.metrics.holdsExpired.inc(result.reservations);
        log({
          reservations_expired: result.reservations,
          seats_released: result.seats,
        }).info('expired holds released');
      }

      this.ticksSincePurge += 1;
      // Key reaping is housekeeping, not correctness; once a minute is plenty.
      if (this.ticksSincePurge * this.cfg.resilience.expirySweepIntervalMs >= 60_000) {
        this.ticksSincePurge = 0;
        const purged = await this.idempotency.purgeExpired();
        if (purged > 0) log({ purged }).debug('idempotency keys purged');
      }
    } catch (err) {
      // A failed sweep is self-healing: the next tick picks the same rows up.
      log({ err: String(err) }).warn('expiry sweep failed, will retry next tick');
    } finally {
      this.running = false;
    }
  }
}
