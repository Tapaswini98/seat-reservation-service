import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { loadConfig } from '../../config/configuration';
import { ReservationRepository } from '../../models/repositories/reservation.repository';
import { IdempotencyService } from './idempotency.service';
import { MetricsService } from '../metrics/metrics.service';
import { log } from '../../shared/logger/logger';

const IDEMPOTENCY_PURGE_INTERVAL_MS = 60_000;

/**
 * Releases holds whose TTL has passed, and reaps idempotency keys past theirs.
 *
 * Deliberately a plain interval rather than a cron expression: the tick is
 * short and the work is bounded per pass, so a slow database degrades into
 * "expiry is a bit late" instead of "overlapping sweeps pile up on the pool".
 * A re-entrancy guard enforces one sweep at a time per instance, and SKIP
 * LOCKED in the query handles more than one instance.
 */
@Injectable()
export class ExpiryCronService implements OnModuleInit, OnModuleDestroy {
  private readonly config = loadConfig();
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;
  private msSincePurge = 0;

  constructor(
    private readonly reservationRepository: ReservationRepository,
    private readonly idempotencyService: IdempotencyService,
    private readonly metricsService: MetricsService,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(
      () => void this.tick(),
      this.config.resilience.expirySweepIntervalMs,
    );
    this.timer.unref();
  }

  onModuleDestroy(): void {
    // Set before clearing the timer so a tick already in flight stops touching
    // a data source that is about to be destroyed, and a late failure is not
    // logged as if the sweeper were broken.
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
  }

  async tick(): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;

    try {
      const result = await this.reservationRepository.sweepExpiredHolds(
        this.config.resilience.expirySweepBatch,
      );
      if (result.reservations > 0) {
        this.metricsService.holdsExpired.inc(result.reservations);
        log({
          reservations_expired: result.reservations,
          seats_released: result.seats,
        }).info('expired holds released');
      }

      // Key reaping is housekeeping, not correctness; once a minute is plenty.
      this.msSincePurge += this.config.resilience.expirySweepIntervalMs;
      if (this.msSincePurge >= IDEMPOTENCY_PURGE_INTERVAL_MS) {
        this.msSincePurge = 0;
        const purged = await this.idempotencyService.purgeExpired();
        if (purged > 0) log({ purged }).debug('expired idempotency keys purged');
      }
    } catch (err) {
      if (this.stopped) return;
      // A failed sweep is self-healing: the next tick picks the same rows up.
      log({ err: String(err) }).warn('expiry sweep failed, will retry next tick');
    } finally {
      this.running = false;
    }
  }
}
