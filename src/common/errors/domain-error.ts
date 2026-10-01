/**
 * Every outcome the domain can produce on purpose. A decline is a business
 * result, not a failure, so each of these maps to a 4xx. Anything that is NOT
 * one of these is a genuine bug or an infrastructure fault and is allowed to
 * be a 5xx — we never dress a real failure up as a decline.
 */
export enum DeclineReason {
  SEAT_TAKEN = 'seat_taken',
  PER_USER_LIMIT = 'per_user_limit',
  IDEMPOTENT_REPLAY = 'idempotent_replay',
  IDEMPOTENCY_KEY_REUSE = 'idempotency_key_reuse',
  REQUEST_IN_FLIGHT = 'request_in_flight',
  SHOW_NOT_FOUND = 'show_not_found',
  SEAT_NOT_FOUND = 'seat_not_found',
  RESERVATION_NOT_FOUND = 'reservation_not_found',
  NOT_RESERVATION_OWNER = 'not_reservation_owner',
  RESERVATION_NOT_HELD = 'reservation_not_held',
  RESERVATION_EXPIRED = 'reservation_expired',
  SHOW_NAME_TAKEN = 'show_name_taken',
  VALIDATION_FAILED = 'validation_failed',
  UNAUTHENTICATED = 'unauthenticated',
  FORBIDDEN = 'forbidden',
  SERVICE_BUSY = 'service_busy',
}

export class DomainError extends Error {
  constructor(
    readonly reason: DeclineReason,
    readonly httpStatus: number,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'DomainError';
  }

  static seatTaken(seats: string[]): DomainError {
    return new DomainError(
      DeclineReason.SEAT_TAKEN,
      409,
      `Seat(s) already taken: ${seats.join(', ')}`,
      { unavailable_seats: seats },
    );
  }

  static perUserLimit(limit: number, held: number, requested: number): DomainError {
    return new DomainError(
      DeclineReason.PER_USER_LIMIT,
      409,
      `Per-user limit of ${limit} seat(s) for this show would be exceeded`,
      { per_user_limit: limit, currently_held: held, requested },
    );
  }

  static idempotencyKeyReuse(): DomainError {
    return new DomainError(
      DeclineReason.IDEMPOTENCY_KEY_REUSE,
      409,
      'This idempotency key was already used with a different request body',
    );
  }

  static requestInFlight(): DomainError {
    return new DomainError(
      DeclineReason.REQUEST_IN_FLIGHT,
      409,
      'A request with this idempotency key is still in flight; retry shortly',
    );
  }

  static showNotFound(showId: string): DomainError {
    return new DomainError(
      DeclineReason.SHOW_NOT_FOUND,
      404,
      `Show ${showId} not found`,
    );
  }

  static seatNotFound(seats: string[]): DomainError {
    return new DomainError(
      DeclineReason.SEAT_NOT_FOUND,
      404,
      `Seat(s) do not exist for this show: ${seats.join(', ')}`,
      { unknown_seats: seats },
    );
  }

  static reservationNotFound(id: string): DomainError {
    return new DomainError(
      DeclineReason.RESERVATION_NOT_FOUND,
      404,
      `Reservation ${id} not found`,
    );
  }

  /**
   * Deliberately 404, not 403: a non-owner must not be able to probe which
   * reservation ids exist. The owner check and the existence check return the
   * same thing to a stranger.
   */
  static notReservationOwner(id: string): DomainError {
    return new DomainError(
      DeclineReason.NOT_RESERVATION_OWNER,
      404,
      `Reservation ${id} not found`,
    );
  }

  static reservationNotHeld(status: string): DomainError {
    return new DomainError(
      DeclineReason.RESERVATION_NOT_HELD,
      409,
      `Reservation is ${status} and cannot be confirmed`,
      { status },
    );
  }

  static reservationExpired(): DomainError {
    return new DomainError(
      DeclineReason.RESERVATION_EXPIRED,
      409,
      'Hold has expired and its seats were released',
    );
  }

  static showNameTaken(name: string): DomainError {
    return new DomainError(
      DeclineReason.SHOW_NAME_TAKEN,
      409,
      `A show named "${name}" already exists`,
    );
  }

  static validation(message: string, details?: Record<string, unknown>): DomainError {
    return new DomainError(DeclineReason.VALIDATION_FAILED, 422, message, details);
  }

  /**
   * The overload valve. Returned when we cannot get a database connection in
   * time. It is a 429 and not a 503 on purpose: shedding load is a client-
   * retryable outcome, and a 5xx during an on-sale burst is indistinguishable
   * from a correctness bug to whoever is watching the dashboard.
   */
  static serviceBusy(): DomainError {
    return new DomainError(
      DeclineReason.SERVICE_BUSY,
      429,
      'Service is saturated, retry shortly',
    );
  }
}
