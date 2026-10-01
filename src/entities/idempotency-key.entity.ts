import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

export const IDEMPOTENCY_STATUSES = ['in_progress', 'completed', 'declined'] as const;
export type IdempotencyStatus = (typeof IDEMPOTENCY_STATUSES)[number];

/**
 * Scoped to (user, key) and deliberately NOT to the show: one key means one
 * operation. Reusing a key for a different show is the same violation as
 * reusing it for different seats.
 */
@Entity('idempotency_keys')
@Unique('uq_idempotency_user_key', ['userId', 'idempotencyKey'])
@Index('ix_idempotency_expires_at', ['expiresAt'])
export class IdempotencyKey {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'text', name: 'user_id' })
  userId!: string;

  @Column({ type: 'text', name: 'idempotency_key' })
  idempotencyKey!: string;

  /** sha256 over the canonical request, so a replay with a different body is detectable. */
  @Column({ type: 'text', name: 'request_hash' })
  requestHash!: string;

  @Column({
    type: 'enum',
    enum: IDEMPOTENCY_STATUSES,
    enumName: 'idempotency_status',
  })
  status!: IdempotencyStatus;

  @Column({ type: 'int', name: 'http_status', nullable: true })
  httpStatus!: number | null;

  @Column({ type: 'jsonb', nullable: true })
  response!: Record<string, unknown> | null;

  @Column({ type: 'uuid', name: 'reservation_id', nullable: true })
  reservationId!: string | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @Column({ type: 'timestamptz', name: 'expires_at' })
  expiresAt!: Date;
}
