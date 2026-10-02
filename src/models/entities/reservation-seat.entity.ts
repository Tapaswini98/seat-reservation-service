import { Column, Entity, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { ReservationEntity } from './reservation.entity';

/**
 * Immutable record of which seats a reservation covered.
 *
 * Liveness lives on the seat row; this table exists only so a cancelled or
 * expired reservation can still report what it was for. Nothing reads it to
 * decide whether a seat is free.
 */
@Entity({ name: 'reservation_seats' })
export class ReservationSeatEntity {
  @PrimaryColumn({ type: 'uuid', name: 'reservation_id' })
  reservationId!: string;

  @PrimaryColumn({ type: 'uuid', name: 'seat_id' })
  seatId!: string;

  @Column({
    type: 'text',
    name: 'seat_number',
  })
  seatNumber!: string;

  @ManyToOne(() => ReservationEntity, (r) => r.reservationSeats, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'reservation_id' })
  reservation?: ReservationEntity;
}
