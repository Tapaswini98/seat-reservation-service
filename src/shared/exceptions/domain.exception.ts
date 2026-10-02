import { DeclineReason } from '../enums/reservation.enum';

/**
 * A business outcome that is not a success.
 *
 * Distinct from `HttpException` on purpose: these are the only throwables the
 * domain raises deliberately, and the global filter trusts that distinction to
 * decide what is a 4xx decline and what is a 5xx fault. Keeping them in one
 * class with a `reason` from a closed enum is also what lets the metrics label
 * and the response `error.code` come from the same source, so a dashboard can
 * never disagree with what the client was told.
 */
export class DomainException extends Error {
  constructor(
    readonly reason: DeclineReason,
    readonly httpStatus: number,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'DomainException';
  }

  static seatTaken(seats: string[]): DomainException {
    return new DomainException(
      DeclineReason.SEAT_TAKEN,
      409,
      `Seat(s) already taken: ${seats.join(', ')}`,
      { unavailable_seats: seats },
    );
  }

  static perUserLimit(limit: number, held: number, requested: number): DomainException {
    return new DomainException(
      DeclineReason.PER_USER_LIMIT,
      409,
      `Per-user limit of ${limit} seat(s) for this show would be exceeded`,
      { per_user_limit: limit, currently_held: held, requested },
    );
  }

  static idempotencyKeyReuse(): DomainException {
    return new DomainException(
      DeclineReason.IDEMPOTENCY_KEY_REUSE,
      409,
      'This idempotency key was already used with a different request body',
    );
  }

  static requestInFlight(): DomainException {
    return new DomainException(
      DeclineReason.REQUEST_IN_FLIGHT,
      409,
      'A request with this idempotency key is still in flight; retry shortly',
    );
  }

  static showNotFound(showId: string): DomainException {
    return new DomainException(
      DeclineReason.SHOW_NOT_FOUND,
      404,
      `Show ${showId} not found`,
    );
  }

  static seatNotFound(seats: string[]): DomainException {
    return new DomainException(
      DeclineReason.SEAT_NOT_FOUND,
      404,
      `Seat(s) do not exist for this show: ${seats.join(', ')}`,
      { unknown_seats: seats },
    );
  }

  static reservationNotFound(reservationId: string): DomainException {
    return new DomainException(
      DeclineReason.RESERVATION_NOT_FOUND,
      404,
      `Reservation ${reservationId} not found`,
    );
  }

  /**
   * Deliberately 404 and deliberately worded identically to
   * `reservationNotFound`: a stranger must not be able to tell "exists but
   * isn't yours" from "doesn't exist", or reservation ids become enumerable.
   */
  static notReservationOwner(reservationId: string): DomainException {
    return new DomainException(
      DeclineReason.NOT_RESERVATION_OWNER,
      404,
      `Reservation ${reservationId} not found`,
    );
  }

  static reservationNotHeld(status: string): DomainException {
    return new DomainException(
      DeclineReason.RESERVATION_NOT_HELD,
      409,
      `Reservation is ${status} and cannot be confirmed`,
      { status },
    );
  }

  static reservationExpired(): DomainException {
    return new DomainException(
      DeclineReason.RESERVATION_EXPIRED,
      409,
      'Hold has expired and its seats were released',
    );
  }

  static showNameTaken(name: string): DomainException {
    return new DomainException(
      DeclineReason.SHOW_NAME_TAKEN,
      409,
      `A show named "${name}" already exists`,
    );
  }

  static validation(
    message: string,
    details?: Record<string, unknown>,
  ): DomainException {
    return new DomainException(DeclineReason.VALIDATION_FAILED, 422, message, details);
  }

  /**
   * The overload valve, returned when a pool connection cannot be acquired in
   * time. 429 and not 503 on purpose: the pool clears in milliseconds, so
   * retrying genuinely helps, and a 5xx during an on-sale is indistinguishable
   * from a correctness bug to whoever is watching the dashboard.
   */
  static serviceBusy(): DomainException {
    return new DomainException(
      DeclineReason.SERVICE_BUSY,
      429,
      'Service is saturated, retry shortly',
    );
  }
}
