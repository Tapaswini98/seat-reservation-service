export enum ReservationStatus {
  Held = 'held',
  Confirmed = 'confirmed',
  Cancelled = 'cancelled',
  Expired = 'expired',
}

export const RESERVATION_STATUS_ENUM_NAME = 'reservation_status';

/**
 * Every outcome the domain can produce on purpose.
 *
 * A decline is a business result, not a failure, so each of these maps to a
 * 4xx. Anything NOT in this enum is a genuine bug or an infrastructure fault
 * and is allowed to be a 5xx -- we never dress a real failure up as a decline.
 *
 * These values are also the `reason` label on `reservations_declined_total`
 * and the `error.code` in responses, so they are a public contract: adding a
 * member is safe, renaming one breaks dashboards and clients at once.
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
  DEPENDENCY_UNAVAILABLE = 'dependency_unavailable',
  INTERNAL_ERROR = 'internal_error',
}
