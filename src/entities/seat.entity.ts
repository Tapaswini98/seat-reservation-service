import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import { Show } from './show.entity';

export const SEAT_STATUSES = ['available', 'held', 'confirmed'] as const;
export type SeatStatus = (typeof SEAT_STATUSES)[number];

/**
 * The seat row IS the resource being sold. There is exactly one row per
 * (show, seat_number) and its `status` column is a NOT NULL three-valued enum,
 * which is why `available + held + confirmed == total_seats` is structurally
 * true rather than an invariant we have to maintain.
 */
@Entity('seats')
@Unique('uq_seats_show_seat_number', ['showId', 'seatNumber'])
@Index('ix_seats_show_status', ['showId', 'status'])
export class Seat {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'show_id' })
  showId!: string;

  @Column({ type: 'text', name: 'seat_number' })
  seatNumber!: string;

  @Column({
    type: 'enum',
    enum: SEAT_STATUSES,
    enumName: 'seat_status',
    default: 'available',
  })
  status!: SeatStatus;

  @Column({ type: 'uuid', name: 'reservation_id', nullable: true })
  reservationId!: string | null;

  /** Denormalised from the reservation so the per-user quota count is one index hit. */
  @Column({ type: 'text', name: 'owner_user_id', nullable: true })
  ownerUserId!: string | null;

  @Column({ type: 'timestamptz', name: 'held_until', nullable: true })
  heldUntil!: Date | null;

  @Column({ type: 'int', default: 0 })
  version!: number;

  @ManyToOne(() => Show, (show) => show.seats, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'show_id' })
  show?: Show;
}
