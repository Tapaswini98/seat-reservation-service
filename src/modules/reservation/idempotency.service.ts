import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { loadConfig } from '../../config/configuration';
import { IdempotencyKeyRepository } from '../../models/repositories/idempotency-key.repository';
import { IdempotencyOutcome } from './interfaces';
import { IdempotencyStatus } from '../../shared/enums/idempotency.enum';
import { DomainException } from '../../shared/exceptions/domain.exception';
import { log } from '../../shared/logger/logger';

/**
 * Poll interval for a duplicate waiting on the original, backing off from
 * this floor. The total budget is configurable (IDEMPOTENCY_WAIT_MS) and must
 * sit above p99 reservation latency: set it too low and an honest retry gets
 * `request_in_flight` instead of the reservation being created for it at that
 * very moment. At 250ms, 29% of duplicates in a 20k burst timed out; at
 * 2000ms, none did.
 */
const POLL_FLOOR_MS = 20;
const POLL_CEILING_MS = 200;

@Injectable()
export class IdempotencyService {
  private readonly config = loadConfig();

  constructor(private readonly idempotencyKeyRepository: IdempotencyKeyRepository) {}

  /**
   * Canonical form, so key reuse is detected on *meaning* rather than byte
   * equality. Seats are sorted because ["A12","A13"] and ["A13","A12"] are
   * the same request, and an absent hold is distinct from a zero-length one.
   */
  hashRequest(input: {
    showId: string;
    seatNumbers: string[];
    holdSeconds?: number;
  }): string {
    const canonical = JSON.stringify({
      show_id: input.showId,
      seats: [...input.seatNumbers].sort(),
      hold_seconds: input.holdSeconds ?? null,
    });
    return createHash('sha256').update(canonical).digest('hex');
  }

  /**
   * Phase 1 of three. The key row is inserted and committed BEFORE the
   * reservation work begins, which is the whole point: written inside the
   * reservation transaction, a declined attempt would roll the key away and
   * "same key, different body" would stop being detectable the moment
   * anything went wrong. The key must outlive a failed attempt.
   */
  async begin(
    userId: string,
    key: string,
    requestHash: string,
  ): Promise<IdempotencyOutcome> {
    const claimedKeyId = await this.idempotencyKeyRepository.tryClaim({
      userId,
      key,
      requestHash,
      ttlHours: this.config.domain.idempotencyTtlHours,
    });
    if (claimedKeyId) return { kind: 'proceed', keyId: claimedKeyId };

    const deadline = Date.now() + this.config.domain.idempotencyWaitMs;
    let pollMs = POLL_FLOOR_MS;

    for (;;) {
      const existing = await this.idempotencyKeyRepository.findByUserAndKey(
        userId,
        key,
      );

      if (!existing) {
        // Reaped between our INSERT and our SELECT. Vanishingly rare; treat
        // the request as fresh rather than failing it.
        log({ user_id: userId }).warn('idempotency key vanished, proceeding unkeyed');
        return { kind: 'proceed', keyId: '' };
      }

      if (existing.request_hash !== requestHash) {
        throw DomainException.idempotencyKeyReuse();
      }

      if (existing.status !== IdempotencyStatus.InProgress) {
        return {
          kind: 'replay',
          httpStatus: existing.http_status ?? 200,
          response: existing.response ?? {},
        };
      }

      // The original is still running. Wait briefly rather than declining
      // immediately: a client that fired the same key twice in parallel
      // should get the original reservation back, not a confusing conflict.
      if (Date.now() >= deadline) throw DomainException.requestInFlight();
      await sleep(pollMs);
      pollMs = Math.min(pollMs * 2, POLL_CEILING_MS);
    }
  }

  /**
   * Phase 3. The decline rolled the reservation transaction back, so the
   * outcome is recorded afterwards in its own statement. If this write is
   * lost the key stays `in_progress` and the TTL sweeper reaps it -- the
   * failure mode is a retry being re-evaluated, which is harmless, rather
   * than a lost reservation.
   */
  async recordDecline(
    keyId: string,
    httpStatus: number,
    response: Record<string, unknown>,
  ): Promise<void> {
    if (!keyId) return;
    try {
      await this.idempotencyKeyRepository.markDeclined(keyId, httpStatus, response);
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
      await this.idempotencyKeyRepository.releaseClaim(keyId);
    } catch {
      /* the TTL sweeper will reap it */
    }
  }

  async purgeExpired(limit = 1000): Promise<number> {
    return this.idempotencyKeyRepository.deleteExpired(limit);
  }
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
