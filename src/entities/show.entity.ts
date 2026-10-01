import {
  Column,
  CreateDateColumn,
  Entity,
  OneToMany,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Seat } from './seat.entity';

@Entity('shows')
export class Show {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'text', unique: true })
  name!: string;

  /** Money is always integer minor units (paise). bigint maps to string in pg. */
  @Column({ type: 'bigint', name: 'price_paise' })
  pricePaise!: string;

  @Column({ type: 'int', name: 'per_user_limit', default: 4 })
  perUserLimit!: number;

  @Column({ type: 'int', name: 'total_seats' })
  totalSeats!: number;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @OneToMany(() => Seat, (seat) => seat.show)
  seats?: Seat[];
}
