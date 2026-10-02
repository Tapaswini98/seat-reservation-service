import { CreateDateColumn, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

/**
 * Shared base for entities whose id is exposed over the API.
 *
 * UUIDs rather than the house `bigint` auto-increment: reservation and show
 * ids travel in URLs, and a sequential integer would let anyone enumerate
 * other people's reservations by counting. There is also no `deletedAt` here
 * -- nothing in this schema is ever soft-deleted, because a seat row that
 * disappears from a query would silently break the
 * `available + held + confirmed == total_seats` invariant.
 */
export abstract class UuidEntity {
  @PrimaryGeneratedColumn('uuid', { name: 'id' })
  id!: string;
}

export abstract class TimestampedUuidEntity extends UuidEntity {
  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;
}
