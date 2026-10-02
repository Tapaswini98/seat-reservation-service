import { Injectable } from '@nestjs/common';
import { loadConfig } from '../../config/configuration';
import { ReservationRepository } from '../../models/repositories/reservation.repository';
import { IdempotencyService } from './idempotency.service';
import { ReserveSeatsDto } from './dto/reserve-seats.dto';
import { ReservationView } from './interfaces';
import { MetricsService } from '../metrics/metrics.service';
import { DeclineReason, ReservationStatus } from '../../shared/enums/reservation.enum';
import { DomainException } from '../../shared/exceptions/domain.exception';
import { isUuid } from '../../shared/helpers/uuid.helper';
import { log } from '../../shared/logger/logger';

@Injectable()
export class ReservationService {
  private readonly config = loadConfig();

  constructor(
    private readonly reservationRepository: ReservationRepository,
    private readonly idempotencyService: IdempotencyService,
    private readonly metricsService: MetricsService,
  ) {}

  async reserve(
    userId: string,
    showId: string,
    dto: ReserveSeatsDto,
    headerKey?: string,
  ): Promise<ReservationView> {
    const startedAt = process.hrtime.bigint();

    // Guard before the id reaches Postgres: a malformed uuid would otherwise
    // raise `invalid input syntax` and become a 500 for what is really a 404.
    if (!isUuid(showId)) throw DomainException.showNotFound(showId);

    if (
      dto.hold_seconds !== undefined &&
      dto.hold_seconds > this.config.domain.maxHoldSeconds
    ) {
      throw DomainException.validation(
        `hold_seconds must not exceed ${this.config.domain.maxHoldSeconds}`,
      );
    }

    // Header wins over body: a proxy or client library that sets the standard
    // header should not be overridden by a stale value in a replayed payload.
    const key = (headerKey ?? dto.idempotency_key)?.trim() || undefined;
    const seatNumbers = [...new Set(dto.seats)].sort();

    let keyId = '';
    if (key) {
      const outcome = await this.idempotencyService.begin(
        userId,
        key,
        this.idempotencyService.hashRequest({
          showId,
          seatNumbers,
          holdSeconds: dto.hold_seconds,
        }),
      );

      if (outcome.kind === 'replay') {
        this.metricsService.declined(DeclineReason.IDEMPOTENT_REPLAY);
        this.observeDuration(startedAt, DeclineReason.IDEMPOTENT_REPLAY);

        if (outcome.httpStatus >= 400) {
          // The original attempt was declined. Replay the identical decline,
          // so a retry can never turn a "no" into a "yes" by racing -- the
          // same class of bug that makes retried payments double-charge.
          throw rebuildDecline(outcome.httpStatus, outcome.response);
        }

        log({ show_id: showId, seats: seatNumbers, key }).info(
          'idempotent replay served',
        );
        return {
          ...(outcome.response as unknown as ReservationView),
          idempotent_replay: true,
        };
      }

      keyId = outcome.keyId;
    }

    try {
      const reservation = await this.reservationRepository.reserveSeats({
        userId,
        showId,
        seatNumbers,
        holdSeconds: dto.hold_seconds,
        idempotencyKeyId: keyId,
      });

      if (reservation.status === ReservationStatus.Held) {
        this.metricsService.reservationsHeld.inc();
      } else {
        this.metricsService.reservationsConfirmed.inc();
      }
      this.metricsService.seatsAllocated.inc(reservation.seats.length);
      this.observeDuration(startedAt, reservation.status);

      log({
        show_id: showId,
        reservation_id: reservation.reservation_id,
        seats: reservation.seats,
        amount_paise: reservation.amount_paise,
        outcome: reservation.status,
      }).info('reservation created');

      return reservation;
    } catch (err) {
      if (err instanceof DomainException) {
        this.metricsService.declined(err.reason);
        this.observeDuration(startedAt, err.reason);
        await this.idempotencyService.recordDecline(keyId, err.httpStatus, {
          error: {
            code: err.reason,
            message: err.message,
            ...(err.details ? { details: err.details } : {}),
          },
        });

        log({
          show_id: showId,
          seats: seatNumbers,
          outcome: 'declined',
          reason: err.reason,
        }).info('reservation declined');
        throw err;
      }

      // Not a decision, a fault. Release the key so an honest retry is not
      // permanently blocked by a request that never received an answer.
      await this.idempotencyService.abandon(keyId);
      this.observeDuration(startedAt, 'error');
      throw err;
    }
  }

  async confirm(reservationId: string, userId: string): Promise<ReservationView> {
    if (!isUuid(reservationId)) {
      throw DomainException.reservationNotFound(reservationId);
    }
    const reservation = await this.reservationRepository.confirmReservation(
      reservationId,
      userId,
    );
    this.metricsService.reservationsConfirmed.inc();
    log({ reservation_id: reservationId }).info('hold confirmed');
    return reservation;
  }

  async cancel(reservationId: string, userId: string): Promise<ReservationView> {
    if (!isUuid(reservationId)) {
      throw DomainException.reservationNotFound(reservationId);
    }
    const reservation = await this.reservationRepository.cancelReservation(
      reservationId,
      userId,
    );
    this.metricsService.reservationsCancelled.inc();
    return reservation;
  }

  findOne(reservationId: string, userId: string): Promise<ReservationView> {
    if (!isUuid(reservationId)) {
      throw DomainException.reservationNotFound(reservationId);
    }
    return this.reservationRepository.findOwnedById(reservationId, userId);
  }

  private observeDuration(startedAt: bigint, outcome: string): void {
    const seconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
    this.metricsService.reservationDuration.observe({ outcome }, seconds);
  }
}

const rebuildDecline = (
  httpStatus: number,
  stored: Record<string, unknown>,
): DomainException => {
  const error = (stored.error ?? {}) as {
    code?: string;
    message?: string;
    details?: Record<string, unknown>;
  };
  return new DomainException(
    (error.code as DeclineReason) ?? DeclineReason.SEAT_TAKEN,
    httpStatus,
    error.message ?? 'Request previously declined',
    error.details,
  );
};
