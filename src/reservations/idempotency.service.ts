import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { createHash } from 'node:crypto';
import { loadConfig } from '../config/configuration';
import { DeclineReason, DomainError } from '../common/errors/domain-error';
import { log } from '../common/logging/logger';
import { rowsOf } from '../common/pg-result';

export type IdempotencyOutcome =
  | { kind: 'proceed'; keyId: string }
  | { kind: 'replay'; httpStatus: number; response: Record<string, unknown> };

interface KeyRow {
  id: string;
  request_hash: string;
  status: 'in_progress' | 'completed' | 'declined';
  http_status: number | null;
  response: Record<string, unknown> | null;
}

/**
 * Poll interval for a duplicate waiting on the original, backing off from this
 * floor. The total budget is configurable (IDEMPOTENCY_WAIT_MS) and needs to
 * sit above p99 reservation latency: set it too low and a perfectly honest
 * retry gets `request_in_flight` instead of the reservation that was being
 * created for it at that very moment.
 */
const IN_FLIGHT_POLL_FLOOR_MS = 20;
const IN_FLIGHT_POLL_CEILING_MS = 200;

@Injectable()
export class IdempotencyService {
  private readonly cfg = loadConfig();

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /**
   * Canonical form, so key reuse is detected on *meaning* rather than on byte
   * equality. Seats are sorted because ["A12","A13"] and ["A13","A12"] are the
   * same request, and an absent hold is distinct from a zero-length one.
   */
  hashRequest(input: {
    showId: string;
    seats: string[];
    holdSeconds?: number;
  }): string {
    const canonical = JSON.stringify({
      show_id: input.showId,
      seats: [...input.seats].sort(),
      hold_seconds: input.holdSeconds ?? null,
    });
    return createHash('sha256').update(canonical).digest('hex');
  }

  /**
   * Phase 1 of three. The key row is inserted and committed BEFORE the
   * reservation work begins, which is the whole point: if it were written
   * inside the reservation transaction, a declined attempt would roll the key
   * away and "same key, different body" would stop being detectable the moment
   * anything went wrong. INSERT ... ON CONFLICT DO NOTHING ... RETURNING is
   * also what serialises two simultaneous uses of one key -- the loser blocks
   * on the unique index until the winner commits, then reads its row. There is
   * no read-then-write anywhere in this path.
   */
  async begin(
    userId: string,
    key: string,
    requestHash: string,
  ): Promise<IdempotencyOutcome> {
    const inserted: Array<{ id: string }> = await this.dataSource.query(
      `INSERT INTO idempotency_keys
         (user_id, idempotency_key, request_hash, status, expires_at)
       VALUES ($1, $2, $3, 'in_progress', now() + make_interval(hours => $4))
       ON CONFLICT ON CONSTRAINT uq_idempotency_user_key DO NOTHING
       RETURNING id`,
      [userId, key, requestHash, this.cfg.domain.idempotencyTtlHours],
    );

    if (inserted.length > 0) {
      return { kind: 'proceed', keyId: inserted[0].id };
    }

    const deadline = Date.now() + this.cfg.domain.idempotencyWaitMs;
    let pollMs = IN_FLIGHT_POLL_FLOOR_MS;
    for (;;) {
      const existing = await this.load(userId, key);

      if (!existing) {
        // The row was reaped between our INSERT and our SELECT. Vanishingly
        // rare; treat the request as fresh rather than failing it.
        log({ user_id: userId }).warn('idempotency key vanished, proceeding unkeyed');
        return { kind: 'proceed', keyId: '' };
      }

      if (existing.request_hash !== requestHash) {
        throw DomainError.idempotencyKeyReuse();
      }

      if (existing.status !== 'in_progress') {
        return {
          kind: 'replay',
          httpStatus: existing.http_status ?? 200,
          response: existing.response ?? {},
        };
      }

      // The original is still running. Wait briefly rather than immediately
      // declining: a client that fired the same key twice in parallel should
      // get the original reservation back, not a confusing conflict.
      if (Date.now() >= deadline) throw DomainError.requestInFlight();
      await sleep(pollMs);
      pollMs = Math.min(pollMs * 2, IN_FLIGHT_POLL_CEILING_MS);
    }
  }

  /**
   * Phase 2. Runs on the SAME EntityManager as the reservation insert, so the
   * key is marked completed in the very transaction that creates the
   * reservation. The two can never disagree: either both commit or neither does.
   */
  async completeInTransaction(
    manager: EntityManager,
    keyId: string,
    httpStatus: number,
    response: Record<string, unknown>,
    reservationId: string,
  ): Promise<void> {
    if (!keyId) return;
    await manager.query(
      `UPDATE idempotency_keys
       SET status = 'completed', http_status = $2, response = $3::jsonb, reservation_id = $4
       WHERE id = $1`,
      [keyId, httpStatus, JSON.stringify(response), reservationId],
    );
  }

  /**
   * Phase 3. A decline rolled the reservation transaction back, so the outcome
   * is recorded afterwards in its own statement. If this write is lost the key
   * stays `in_progress` and the TTL sweeper reaps it -- the failure mode is a
   * retry being re-evaluated, which is harmless, rather than a lost reservation.
   */
  async recordDecline(
    keyId: string,
    httpStatus: number,
    response: Record<string, unknown>,
  ): Promise<void> {
    if (!keyId) return;
    try {
      await this.dataSource.query(
        `UPDATE idempotency_keys
         SET status = 'declined', http_status = $2, response = $3::jsonb
         WHERE id = $1 AND status = 'in_progress'`,
        [keyId, httpStatus, JSON.stringify(response)],
      );
    } catch (err) {
      log({ key_id: keyId, err: String(err) }).warn(
        'failed to persist idempotent decline; key will expire via TTL',
      );
    }
  }

  /** Releases a key whose attempt failed for a non-domain reason, so a retry can proceed. */
  async abandon(keyId: string): Promise<void> {
    if (!keyId) return;
    try {
      await this.dataSource.query(
        `DELETE FROM idempotency_keys WHERE id = $1 AND status = 'in_progress'`,
        [keyId],
      );
    } catch {
      /* TTL will reap it */
    }
  }

  async purgeExpired(limit = 1000): Promise<number> {
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

  private async load(userId: string, key: string): Promise<KeyRow | null> {
    const rows: KeyRow[] = await this.dataSource.query(
      `SELECT id, request_hash, status::text AS status, http_status, response
       FROM idempotency_keys
       WHERE user_id = $1 AND idempotency_key = $2`,
      [userId, key],
    );
    return rows[0] ?? null;
  }
}

export const REPLAY_REASON = DeclineReason.IDEMPOTENT_REPLAY;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
