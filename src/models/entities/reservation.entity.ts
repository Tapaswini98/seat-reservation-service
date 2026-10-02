import { Column, Entity, Index, OneToMany } from 'typeorm';
import { TimestampedUuidEntity } from './base.entity';
import { ReservationSeatEntity } from './reservation-seat.entity';
import {
  RESERVATION_STATUS_ENUM_NAME,
  ReservationStatus,
} from '../../shared/enums/reservation.enum';

@Entity({ name: 'reservations' })
@Index('IDX_RESERVATIONS_SHOW_USER', ['showId', 'userId'])
export class ReservationEntity extends TimestampedUuidEntity {
  @Column({
    type: 'uuid',
    name: 'show_id',
  })
  showId!: string;

  /** Always the verified JWT subject. Never read from a request body. */
  @Column({
    type: 'text',
    name: 'user_id',
  })
  userId!: string;

  @Column({
    type: 'enum',
    name: 'status',
    enum: ReservationStatus,
    enumName: RESERVATION_STATUS_ENUM_NAME,
  })
  status!: ReservationStatus;

  @Column({
    type: 'int',
    name: 'seat_count',
  })
  seatCount!: number;

  @Column({
    type: 'bigint',
    name: 'amount_paise',
  })
  amountPaise!: string;

  @Column({
    type: 'timestamptz',
    name: 'expires_at',
    nullable: true,
  })
  expiresAt!: Date | null;

  @OneToMany(() => ReservationSeatEntity, (rs) => rs.reservation)
  reservationSeats?: ReservationSeatEntity[];
}
