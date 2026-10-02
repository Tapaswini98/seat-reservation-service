import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { IdempotencyKeyEntity } from '../entities/idempotency-key.entity';
import { IdempotencyStatus } from '../../shared/enums/idempotency.enum';
import { rowsOf } from '../../shared/helpers/pg-result.helper';

export interface IdempotencyKeyRow {
  id: string;
  request_hash: string;
  status: IdempotencyStatus;
  http_status: number | null;
  response: Record<string, unknown> | null;
}

@Injectable()
export class IdempotencyKeyRepository extends Repository<IdempotencyKeyEntity> {
  constructor(private readonly dataSource: DataSource) {
    super(IdempotencyKeyEntity, dataSource.createEntityManager());
  }

  /**
   * Claims the key, or reports that somebody else already holds it.
   *
   * `INSERT ... ON CONFLICT DO NOTHING ... RETURNING` is what serialises two
   * simultaneous uses of one key: the unique index decides who the original
   * is, the loser blocks on it until the winner commits, and the presence or
   * absence of a returned row tells each caller which one it is. There is no
   * read-then-write anywhere in this path.
   *
   * Returns the new row's id, or null when the key already existed.
   */
  async tryClaim(params: {
    userId: string;
    key: string;
    requestHash: string;
    ttlHours: number;
  }): Promise<string | null> {
    const inserted: Array<{ id: string }> = await this.dataSource.query(
      `INSERT INTO idempotency_keys
         (user_id, idempotency_key, request_hash, status, expires_at)
       VALUES ($1, $2, $3, 'in_progress', now() + make_interval(hours => $4))
       ON CONFLICT ON CONSTRAINT "UQ_IDEMPOTENCY_USER_KEY" DO NOTHING
       RETURNING id`,
      [params.userId, params.key, params.requestHash, params.ttlHours],
    );
    return inserted[0]?.id ?? null;
  }

  async findByUserAndKey(
    userId: string,
    key: string,
  ): Promise<IdempotencyKeyRow | null> {
    const rows: IdempotencyKeyRow[] = await this.dataSource.query(
      `SELECT id, request_hash, status::text AS status, http_status, response
       FROM idempotency_keys
       WHERE user_id = $1 AND idempotency_key = $2`,
      [userId, key],
    );
    return rows[0] ?? null;
  }

  /**
   * Runs on the caller's EntityManager, so the key is marked completed in the
   * very transaction that creates the reservation. The stored response and
   * the reservation therefore commit together or not at all -- they can never
   * disagree.
   */
  async markCompletedInTransaction(
    manager: EntityManager,
    params: {
      keyId: string;
      httpStatus: number;
      response: Record<string, unknown>;
      reservationId: string;
    },
  ): Promise<void> {
    await manager.query(
      `UPDATE idempotency_keys
       SET status = 'completed', http_status = $2, response = $3::jsonb,
           reservation_id = $4
       WHERE id = $1`,
      [
        params.keyId,
        params.httpStatus,
        JSON.stringify(params.response),
        params.reservationId,
      ],
    );
  }

  async markDeclined(
    keyId: string,
    httpStatus: number,
    response: Record<string, unknown>,
  ): Promise<void> {
    await this.dataSource.query(
      `UPDATE idempotency_keys
       SET status = 'declined', http_status = $2, response = $3::jsonb
       WHERE id = $1 AND status = 'in_progress'`,
      [keyId, httpStatus, JSON.stringify(response)],
    );
  }

  /** Releases a key whose attempt failed for a non-domain reason, so a retry can proceed. */
  async releaseClaim(keyId: string): Promise<void> {
    await this.dataSource.query(
      `DELETE FROM idempotency_keys WHERE id = $1 AND status = 'in_progress'`,
      [keyId],
    );
  }

  async deleteExpired(limit: number): Promise<number> {
    const rows = rowsOf<{ id: string }>(
      await this.dataSource.query(
        `DELETE FROM idempotency_keys
         WHERE id IN (
           SELECT id FROM idempotency_keys WHERE expires_at < now() LIMIT $1
         )
         RETURNING id`,
        [limit],
      ),
    );
    return rows.length;
  }
}
