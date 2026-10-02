import { ReservationStatus } from '../../../shared/enums/reservation.enum';

export interface ReservationView {
  reservation_id: string;
  show_id: string;
  user_id: string;
  seats: string[];
  amount_paise: number;
  status: ReservationStatus;
  expires_at: string | null;
  created_at: string;
  /** Present only when this response replays an earlier request with the same key. */
  idempotent_replay?: boolean;
}

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
