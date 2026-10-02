import { SeatStatus } from '../../../shared/enums/seat.enum';

export interface SeatView {
  seat_number: string;
  status: SeatStatus;
  held_until: string | null;
}

export interface ShowStateView {
  id: string;
  name: string;
  price_paise: number;
  per_user_limit: number;
  total_seats: number;
  counts: {
    available: number;
    held: number;
    confirmed: number;
    total: number;
  };
  /** False means the reconciliation invariant has been violated. */
  reconciled: boolean;
  seats: SeatView[];
}
