import { Entity, JoinColumn, ManyToOne, PrimaryColumn, Column } from 'typeorm';
import { Reservation } from './reservation.entity';

/**
 * Immutable record of which seats a reservation covered. Liveness lives on the
 * seat row; this table exists so a cancelled or expired reservation can still
 * report what it was for.
 */
@Entity('reservation_seats')
export class ReservationSeat {
  @PrimaryColumn({ type: 'uuid', name: 'reservation_id' })
  reservationId!: string;

  @PrimaryColumn({ type: 'uuid', name: 'seat_id' })
  seatId!: string;

  @Column({ type: 'text', name: 'seat_number' })
  seatNumber!: string;

  @ManyToOne(() => Reservation, (r) => r.reservationSeats, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'reservation_id' })
  reservation?: Reservation;
}
