import { Column, CreateDateColumn, Entity, OneToMany } from 'typeorm';
import { UuidEntity } from './base.entity';
import { SeatEntity } from './seat.entity';

@Entity({ name: 'shows' })
export class ShowEntity extends UuidEntity {
  @Column({
    type: 'text',
    name: 'name',
    unique: true,
  })
  name!: string;

  /**
   * Integer minor units (paise), never a float. `bigint` maps to string in the
   * pg driver, which is deliberate -- it forces callers through BigInt
   * arithmetic instead of silently losing precision past 2^53.
   */
  @Column({
    type: 'bigint',
    name: 'price_paise',
  })
  pricePaise!: string;

  @Column({
    type: 'int',
    name: 'per_user_limit',
    default: 4,
  })
  perUserLimit!: number;

  @Column({
    type: 'int',
    name: 'total_seats',
  })
  totalSeats!: number;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @OneToMany(() => SeatEntity, (seat) => seat.show)
  seats?: SeatEntity[];
}
