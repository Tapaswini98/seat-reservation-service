import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { ReservationSeat } from './reservation-seat.entity';

export const RESERVATION_STATUSES = [
  'held',
  'confirmed',
  'cancelled',
  'expired',
] as const;
export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];

@Entity('reservations')
@Index('ix_reservations_show_user', ['showId', 'userId'])
@Index('ix_reservations_expiry', ['expiresAt'])
export class Reservation {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'show_id' })
  showId!: string;

  /** Always taken from the verified JWT subject, never from the request body. */
  @Column({ type: 'text', name: 'user_id' })
  userId!: string;

  @Column({
    type: 'enum',
    enum: RESERVATION_STATUSES,
    enumName: 'reservation_status',
  })
  status!: ReservationStatus;

  @Column({ type: 'int', name: 'seat_count' })
  seatCount!: number;

  @Column({ type: 'bigint', name: 'amount_paise' })
  amountPaise!: string;

  @Column({ type: 'timestamptz', name: 'expires_at', nullable: true })
  expiresAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;

  @OneToMany(() => ReservationSeat, (rs) => rs.reservation)
  reservationSeats?: ReservationSeat[];
}
