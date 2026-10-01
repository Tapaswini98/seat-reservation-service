export interface ReservationView {
  reservation_id: string;
  show_id: string;
  user_id: string;
  seats: string[];
  amount_paise: number;
  status: 'held' | 'confirmed' | 'cancelled' | 'expired';
  expires_at: string | null;
  created_at: string;
  /** True when this response replays a previous request with the same key. */
  idempotent_replay?: boolean;
}

export interface ReserveCommand {
  userId: string;
  showId: string;
  seats: string[];
  holdSeconds?: number;
  idempotencyKeyId?: string;
}
