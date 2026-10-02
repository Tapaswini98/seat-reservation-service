export enum SeatStatus {
  Available = 'available',
  Held = 'held',
  Confirmed = 'confirmed',
}

/** Postgres enum type name, shared by the entity and the migration. */
export const SEAT_STATUS_ENUM_NAME = 'seat_status';
