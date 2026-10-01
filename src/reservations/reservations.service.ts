import { Injectable } from '@nestjs/common';
import { loadConfig } from '../config/configuration';
import { DeclineReason, DomainError } from '../common/errors/domain-error';
import { log } from '../common/logging/logger';
import { MetricsService } from '../metrics/metrics.service';
import { isUuid } from '../shows/shows.service';
import { IdempotencyService } from './idempotency.service';
import { ReservationsRepository } from './reservations.repository';
import { ReservationView } from './reservation.types';
import { ReserveSeatsDto } from './dto/reserve-seats.dto';

@Injectable()
export class ReservationsService {
  private readonly cfg = loadConfig();

  constructor(
    private readonly repo: ReservationsRepository,
    private readonly idempotency: IdempotencyService,
    private readonly metrics: MetricsService,
  ) {}

  async reserve(
    userId: string,
    showId: string,
    dto: ReserveSeatsDto,
    headerKey?: string,
  ): Promise<ReservationView> {
    const startedAt = process.hrtime.bigint();
    if (!isUuid(showId)) throw DomainError.showNotFound(showId);

    if (
      dto.hold_seconds !== undefined &&
      dto.hold_seconds > this.cfg.domain.maxHoldSeconds
    ) {
      throw DomainError.validation(
        `hold_seconds must not exceed ${this.cfg.domain.maxHoldSeconds}`,
      );
    }

    // Header wins over body: a proxy or client library that sets the standard
    // header should not be overridden by a stale value in a replayed payload.
    const key = (headerKey ?? dto.idempotency_key)?.trim() || undefined;
    const seats = [...new Set(dto.seats)].sort();

    let keyId = '';
    if (key) {
      const hash = this.idempotency.hashRequest({
        showId,
        seats,
        holdSeconds: dto.hold_seconds,
      });
      const outcome = await this.idempotency.begin(userId, key, hash);

      if (outcome.kind === 'replay') {
        this.metrics.declined(DeclineReason.IDEMPOTENT_REPLAY);
        this.observe(startedAt, 'idempotent_replay');

        if (outcome.httpStatus >= 400) {
          // The original attempt was declined. Replay the identical decline so
          // a retry can never turn a "no" into a "yes" by racing.
          throw replayedDecline(outcome.httpStatus, outcome.response);
        }
        log({ show_id: showId, seats, key }).info('idempotent replay served');
        return {
          ...(outcome.response as unknown as ReservationView),
          idempotent_replay: true,
        };
      }

      keyId = outcome.keyId;
    }

    try {
      const reservation = await this.repo.reserve({
        userId,
        showId,
        seats,
        holdSeconds: dto.hold_seconds,
        idempotencyKeyId: keyId,
      });

      if (reservation.status === 'held') this.metrics.reservationsHeld.inc();
      else this.metrics.reservationsConfirmed.inc();
      this.metrics.seatsSold.inc(reservation.seats.length);
      this.observe(startedAt, reservation.status);

      log({
        show_id: showId,
        reservation_id: reservation.reservation_id,
        seats: reservation.seats,
        amount_paise: reservation.amount_paise,
        outcome: reservation.status,
      }).info('reservation created');

      return reservation;
    } catch (err) {
      if (err instanceof DomainError) {
        this.metrics.declined(err.reason);
        this.observe(startedAt, err.reason);
        await this.idempotency.recordDecline(keyId, err.httpStatus, {
          error: {
            code: err.reason,
            message: err.message,
            ...(err.details ? { details: err.details } : {}),
          },
        });
        log({
          show_id: showId,
          seats,
          outcome: 'declined',
          reason: err.reason,
        }).info('reservation declined');
        throw err;
      }

      // Not a decision, a fault. Release the key so an honest retry is not
      // permanently blocked by a request that never got an answer.
      await this.idempotency.abandon(keyId);
      this.observe(startedAt, 'error');
      throw err;
    }
  }

  async confirm(reservationId: string, userId: string): Promise<ReservationView> {
    if (!isUuid(reservationId)) throw DomainError.reservationNotFound(reservationId);
    const reservation = await this.repo.confirm(reservationId, userId);
    this.metrics.reservationsConfirmed.inc();
    log({ reservation_id: reservationId }).info('hold confirmed');
    return reservation;
  }

  async cancel(reservationId: string, userId: string): Promise<ReservationView> {
    if (!isUuid(reservationId)) throw DomainError.reservationNotFound(reservationId);
    const reservation = await this.repo.cancel(reservationId, userId);
    this.metrics.reservationsCancelled.inc();
    return reservation;
  }

  get(reservationId: string, userId: string): Promise<ReservationView> {
    if (!isUuid(reservationId)) throw DomainError.reservationNotFound(reservationId);
    return this.repo.findOwn(reservationId, userId);
  }

  private observe(startedAt: bigint, outcome: string): void {
    const seconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
    this.metrics.reservationDuration.observe({ outcome }, seconds);
  }
}

const replayedDecline = (
  httpStatus: number,
  stored: Record<string, unknown>,
): DomainError => {
  const error = (stored.error ?? {}) as {
    code?: string;
    message?: string;
    details?: Record<string, unknown>;
  };
  return new DomainError(
    (error.code as DeclineReason) ?? DeclineReason.SEAT_TAKEN,
    httpStatus,
    error.message ?? 'Request previously declined',
    error.details,
  );
};
