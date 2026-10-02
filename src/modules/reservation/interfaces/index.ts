import { ReservationResponseDto } from '../dto/reservation-response.dto';

/**
 * The response DTO class is the single source of truth for this shape -- it
 * carries the OpenAPI metadata, so a field added for the API cannot drift
 * from the field the repository returns.
 */
export type ReservationView = ReservationResponseDto;

export interface ReserveSeatsCommand {
  userId: string;
  showId: string;
  seatNumbers: string[];
  holdSeconds?: number;
  idempotencyKeyId?: string;
}

export interface SweepResult {
  reservations: number;
  seats: number;
}

export type IdempotencyOutcome =
  | { kind: 'proceed'; keyId: string }
  | { kind: 'replay'; httpStatus: number; response: Record<string, unknown> };
