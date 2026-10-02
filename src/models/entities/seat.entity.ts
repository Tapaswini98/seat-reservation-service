import { Column, Entity, Index, JoinColumn, ManyToOne, Unique } from 'typeorm';
import { UuidEntity } from './base.entity';
import { ShowEntity } from './show.entity';
import { SEAT_STATUS_ENUM_NAME, SeatStatus } from '../../shared/enums/seat.enum';

/**
 * The seat row IS the resource being sold.
 *
 * Exactly one row per (show, seat_number), enforced by a unique constraint,
 * with a NOT NULL three-valued status. That is why
 * `available + held + confirmed == total_seats` is structurally true -- a sum
 * over an enum across N rows -- rather than an invariant the application has
 * to remember to maintain.
 */
@Entity({ name: 'seats' })
@Unique('UQ_SEATS_SHOW_SEAT_NUMBER', ['showId', 'seatNumber'])
@Index('IDX_SEATS_SHOW_STATUS', ['showId', 'status'])
@Index('IDX_SEATS_RESERVATION', ['reservationId'])
export class SeatEntity extends UuidEntity {
  @Column({
    type: 'uuid',
    name: 'show_id',
  })
  showId!: string;

  @Column({
    type: 'text',
    name: 'seat_number',
  })
  seatNumber!: string;

  @Column({
    type: 'enum',
    name: 'status',
    enum: SeatStatus,
    enumName: SEAT_STATUS_ENUM_NAME,
    default: SeatStatus.Available,
  })
  status!: SeatStatus;

  @Column({
    type: 'uuid',
    name: 'reservation_id',
    nullable: true,
  })
  reservationId!: string | null;

  /**
   * Denormalised from the reservation so the per-user quota check is a single
   * index-only scan. Kept in step with `reservation_id` by a CHECK constraint,
   * so the two cannot drift.
   */
  @Column({
    type: 'text',
    name: 'owner_user_id',
    nullable: true,
  })
  ownerUserId!: string | null;

  @Column({
    type: 'timestamptz',
    name: 'held_until',
    nullable: true,
  })
  heldUntil!: Date | null;

  @Column({
    type: 'int',
    name: 'version',
    default: 0,
  })
  version!: number;

  @ManyToOne(() => ShowEntity, (show) => show.seats, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'show_id' })
  show?: ShowEntity;
}
