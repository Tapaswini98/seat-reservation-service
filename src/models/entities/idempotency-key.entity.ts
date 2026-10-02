import { Column, CreateDateColumn, Entity, Index, Unique } from 'typeorm';
import { UuidEntity } from './base.entity';
import {
  IDEMPOTENCY_STATUS_ENUM_NAME,
  IdempotencyStatus,
} from '../../shared/enums/idempotency.enum';

/**
 * Scoped to (user, key) and deliberately NOT to the show: one key means one
 * operation, so reusing it for a different show is the same violation as
 * reusing it for different seats.
 */
@Entity({ name: 'idempotency_keys' })
@Unique('UQ_IDEMPOTENCY_USER_KEY', ['userId', 'idempotencyKey'])
@Index('IDX_IDEMPOTENCY_EXPIRES_AT', ['expiresAt'])
export class IdempotencyKeyEntity extends UuidEntity {
  @Column({
    type: 'text',
    name: 'user_id',
  })
  userId!: string;

  @Column({
    type: 'text',
    name: 'idempotency_key',
  })
  idempotencyKey!: string;

  /** sha256 of the canonical request, so a replay with a different body is detectable. */
  @Column({
    type: 'text',
    name: 'request_hash',
  })
  requestHash!: string;

  @Column({
    type: 'enum',
    name: 'status',
    enum: IdempotencyStatus,
    enumName: IDEMPOTENCY_STATUS_ENUM_NAME,
  })
  status!: IdempotencyStatus;

  @Column({
    type: 'int',
    name: 'http_status',
    nullable: true,
  })
  httpStatus!: number | null;

  @Column({
    type: 'jsonb',
    name: 'response',
    nullable: true,
  })
  response!: Record<string, unknown> | null;

  @Column({
    type: 'uuid',
    name: 'reservation_id',
    nullable: true,
  })
  reservationId!: string | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @Column({
    type: 'timestamptz',
    name: 'expires_at',
  })
  expiresAt!: Date;
}
