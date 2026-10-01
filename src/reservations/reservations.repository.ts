import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { loadConfig } from '../config/configuration';
import { DomainError } from '../common/errors/domain-error';
import { isRetryable, sqlState } from '../common/errors/pg-errors';
import { log } from '../common/logging/logger';
import { rowsOf } from '../common/pg-result';
import { MetricsService } from '../metrics/metrics.service';
import { IdempotencyService } from './idempotency.service';
import { ReservationView, ReserveCommand } from './reservation.types';

interface ShowRow {
  id: string;
  price_paise: string;
  per_user_limit: number;
}

interface SeatRow {
  id: string;
  seat_number: string;
  status: 'available' | 'held' | 'confirmed';
}

interface ReservationRow {
  id: string;
  show_id: string;
  user_id: string;
  status: ReservationView['status'];
  seat_count: number;
  amount_paise: string;
  expires_at: Date | null;
  created_at: Date;
}

@Injectable()
export class ReservationsRepository {
  private readonly cfg = loadConfig();

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly idempotency: IdempotencyService,
    private readonly metrics: MetricsService,
  ) {}

  // ---------------------------------------------------------------------------
  // RESERVE -- the atomic decision
  // ---------------------------------------------------------------------------
  /**
   * One transaction at READ COMMITTED. Three independent mechanisms make a
   * double-sell impossible, listed strongest first:
   *
   *   1. The guarded UPDATE is a compare-and-swap: `WHERE status = 'available'`.
   *      Under READ COMMITTED, a writer that blocks on a concurrently-updated
   *      row re-evaluates its WHERE clause against the committed version once
   *      the other transaction ends. So even with every explicit lock removed,
   *      two transactions cannot both get a row back from this statement. This
   *      is the actual guarantee; everything else is there to make the loser's
   *      experience good rather than to make the winner's correct.
   *   2. The SELECT ... FOR UPDATE takes the row locks up front, so a loser
   *      that got past the fast path blocks and then
   *      reads a real status and declines with a precise reason ("A12 is taken")
   *      instead of inferring it from a row count.
   *   3. One row per (show, seat_number), enforced by a unique constraint.
   *      There is no arrangement of the data in which a seat is owned twice.
   *
   * Deadlock: the only multi-row lock set is the seat SELECT, always acquired
   * `ORDER BY seat_number ASC`. Postgres puts the LockRows node above the Sort,
   * so locks really are taken in sorted order, and cancel/confirm use the same
   * order. The global order is advisory(show,user) -> seats ascending, which
   * admits no cycle. We still retry 40P01/40001 as defence in depth.
   */
  async reserve(cmd: ReserveCommand): Promise<ReservationView> {
    const seats = [...new Set(cmd.seats)].sort();
    if (seats.length !== cmd.seats.length) {
      throw DomainError.validation('seats contains duplicate labels');
    }
    if (seats.length > this.cfg.domain.maxSeatsPerReservation) {
      throw DomainError.validation(
        `at most ${this.cfg.domain.maxSeatsPerReservation} seats per request`,
      );
    }

    // Fast path. In a hot-seat storm the overwhelming majority of requests are
    // for a seat that is already gone, and making each of them open a
    // transaction and queue behind the winner's row lock is what turns a 1ms
    // decline into a 450ms one: every loser waits behind every other loser.
    //
    // This unlocked read can only ever produce a DECLINE, never an allocation,
    // so it cannot create a double-sell -- the authoritative decision is still
    // the guarded UPDATE below. Its one wrong outcome is declining a seat that
    // was released in the microseconds after the read, which costs that caller
    // a retry and nothing else.
    await this.precheck(cmd.showId, cmd.userId, seats);

    return this.withRetry('reserve', () =>
      this.dataSource.transaction(async (manager) => {
        // 1. Take the per-(show, user) advisory lock and read the show in a
        //    single round trip. The lock function sits in the target list, so
        //    it is evaluated per output row: an unknown show produces no rows
        //    and therefore takes no lock, which is exactly what we want.
        //
        //    Why an advisory lock at all -- row locks on seats do nothing for
        //    the per-user limit, because two parallel requests for *different*
        //    seats would both read "3 held" and both insert. This is what makes
        //    the quota check sound. It is transaction-scoped (released on
        //    commit or rollback, with no unlock call to leak) and keyed per
        //    (show, user), so the 20k-distinct-buyers case never contends on it.
        const shows: ShowRow[] = await manager.query(
          `SELECT id, price_paise, per_user_limit
           FROM shows
           WHERE id = $1
             AND pg_advisory_xact_lock(hashtextextended($1 || ':' || $2, 0)) IS NOT NULL`,
          [cmd.showId, cmd.userId],
        );
        if (shows.length === 0) throw DomainError.showNotFound(cmd.showId);
        const show = shows[0];

        // 2. Lock every requested seat, in a deterministic order.
        const locked: SeatRow[] = await manager.query(
          `SELECT id, seat_number, status::text AS status
           FROM seats
           WHERE show_id = $1 AND seat_number = ANY($2::text[])
           ORDER BY seat_number ASC
           FOR UPDATE`,
          [cmd.showId, seats],
        );

        const found = new Set(locked.map((s) => s.seat_number));
        const unknown = seats.filter((s) => !found.has(s));
        if (unknown.length > 0) throw DomainError.seatNotFound(unknown);

        // All-or-nothing. A request for [A12, A13] where only A12 is free
        // reserves NOTHING and reports exactly which seats blocked it. The
        // alternative (best-effort) makes the amount charged depend on a race,
        // which is a terrible property for something that takes money.
        const taken = locked
          .filter((s) => s.status !== 'available')
          .map((s) => s.seat_number);
        if (taken.length > 0) throw DomainError.seatTaken(taken);

        // 3. Per-user quota, under the advisory lock taken in step 1.
        const quota: Array<{ held: number }> = await manager.query(
          `SELECT count(*)::int AS held
           FROM seats
           WHERE show_id = $1 AND owner_user_id = $2 AND status <> 'available'`,
          [cmd.showId, cmd.userId],
        );
        const alreadyHeld = quota[0]?.held ?? 0;
        if (alreadyHeld + seats.length > show.per_user_limit) {
          throw DomainError.perUserLimit(
            show.per_user_limit,
            alreadyHeld,
            seats.length,
          );
        }

        // 4. Create the reservation. Money stays in integer paise end to end;
        //    BigInt multiplication, never a float.
        const isHold = cmd.holdSeconds !== undefined;
        const amountPaise = (
          BigInt(show.price_paise) * BigInt(seats.length)
        ).toString();

        const created: ReservationRow[] = await manager.query(
          `INSERT INTO reservations
             (show_id, user_id, status, seat_count, amount_paise, expires_at)
           VALUES ($1, $2, $3::reservation_status, $4, $5,
                   CASE WHEN $6::int IS NULL THEN NULL
                        ELSE now() + make_interval(secs => $6::int) END)
           RETURNING id, show_id, user_id, status::text AS status, seat_count,
                     amount_paise, expires_at, created_at`,
          [
            cmd.showId,
            cmd.userId,
            isHold ? 'held' : 'confirmed',
            seats.length,
            amountPaise,
            cmd.holdSeconds ?? null,
          ],
        );
        const reservation = created[0];

        await manager.query(
          `INSERT INTO reservation_seats (reservation_id, seat_id, seat_number)
           SELECT $1, s.id, s.seat_number
           FROM seats s WHERE s.id = ANY($2::uuid[])`,
          [reservation.id, locked.map((s) => s.id)],
        );

        // 5. The compare-and-swap. `AND status = 'available'` is the guard that
        //    actually prevents the double-sell; the RETURNING row count is how
        //    we verify it fired for every seat. Unreachable given step 2, which
        //    is exactly why it is here -- if the lock reasoning is ever wrong,
        //    this rolls back instead of selling a seat twice.
        const updated = rowsOf<{ id: string }>(
          await manager.query(
            `UPDATE seats
           SET status = $3::seat_status,
               reservation_id = $4,
               owner_user_id = $5,
               held_until = $6,
               version = version + 1
           WHERE show_id = $1
             AND seat_number = ANY($2::text[])
             AND status = 'available'
           RETURNING id`,
            [
              cmd.showId,
              seats,
              isHold ? 'held' : 'confirmed',
              reservation.id,
              cmd.userId,
              isHold ? reservation.expires_at : null,
            ],
          ),
        );
        if (updated.length !== seats.length) {
          log({
            show_id: cmd.showId,
            seats,
            expected: seats.length,
            updated: updated.length,
          }).warn('conditional seat update matched fewer rows than locked');
          throw DomainError.seatTaken(seats);
        }

        const view = toView(reservation, seats);

        // 6. Mark the idempotency key completed in this same transaction, so
        //    the stored response and the reservation commit atomically.
        if (cmd.idempotencyKeyId) {
          await this.idempotency.completeInTransaction(
            manager,
            cmd.idempotencyKeyId,
            201,
            view as unknown as Record<string, unknown>,
            reservation.id,
          );
        }

        return view;
      }),
    );
  }

  // ---------------------------------------------------------------------------
  // CONFIRM -- promote a hold
  // ---------------------------------------------------------------------------
  async confirm(reservationId: string, userId: string): Promise<ReservationView> {
    return this.withRetry('confirm', () =>
      this.dataSource.transaction(async (manager) => {
        const reservation = await this.lockOwnReservation(
          manager,
          reservationId,
          userId,
        );

        if (reservation.status === 'confirmed') {
          // Already there. Confirming twice is a no-op, not an error.
          return this.viewOf(manager, reservation);
        }
        if (reservation.status === 'expired') throw DomainError.reservationExpired();
        if (reservation.status !== 'held') {
          throw DomainError.reservationNotHeld(reservation.status);
        }
        if (reservation.expires_at && reservation.expires_at.getTime() <= Date.now()) {
          throw DomainError.reservationExpired();
        }

        // Guarded on BOTH the reservation id and the current status, so the
        // sweeper and this statement cannot both act on the same seat.
        const promoted = rowsOf<{ seat_number: string }>(
          await manager.query(
            `UPDATE seats
             SET status = 'confirmed', held_until = NULL, version = version + 1
             WHERE reservation_id = $1 AND status = 'held'
             RETURNING seat_number`,
            [reservation.id],
          ),
        );
        if (promoted.length !== reservation.seat_count) {
          // The sweeper released these seats between our read and our write.
          throw DomainError.reservationExpired();
        }

        await manager.query(
          `UPDATE reservations
           SET status = 'confirmed', expires_at = NULL, updated_at = now()
           WHERE id = $1`,
          [reservation.id],
        );

        return toView(
          { ...reservation, status: 'confirmed', expires_at: null },
          promoted.map((p) => p.seat_number).sort(),
        );
      }),
    );
  }

  // ---------------------------------------------------------------------------
  // CANCEL -- release, without ever resurrecting someone else's seat
  // ---------------------------------------------------------------------------
  async cancel(reservationId: string, userId: string): Promise<ReservationView> {
    return this.withRetry('cancel', () =>
      this.dataSource.transaction(async (manager) => {
        const reservation = await this.lockOwnReservation(
          manager,
          reservationId,
          userId,
        );

        if (reservation.status === 'cancelled' || reservation.status === 'expired') {
          return this.viewOf(manager, reservation);
        }

        const seatNumbers = await this.seatNumbersOf(manager, reservation.id);

        // Same ascending lock order as reserve, so a cancel and a reserve that
        // touch overlapping seats can queue but cannot deadlock.
        await manager.query(
          `SELECT id FROM seats
           WHERE reservation_id = $1
           ORDER BY seat_number ASC
           FOR UPDATE`,
          [reservation.id],
        );

        // `WHERE reservation_id = $1` is the clause that makes a release safe:
        // it can only ever free seats that still belong to THIS reservation. A
        // seat already re-sold to somebody else has a different reservation_id
        // and is untouched, so a late cancel can never resurrect it.
        const released = rowsOf<{ id: string }>(
          await manager.query(
            `UPDATE seats
             SET status = 'available', reservation_id = NULL, owner_user_id = NULL,
                 held_until = NULL, version = version + 1
             WHERE reservation_id = $1
             RETURNING id`,
            [reservation.id],
          ),
        );

        await manager.query(
          `UPDATE reservations SET status = 'cancelled', expires_at = NULL, updated_at = now()
           WHERE id = $1`,
          [reservation.id],
        );

        log({
          reservation_id: reservation.id,
          seats_released: released.length,
        }).info('reservation cancelled');

        return toView(
          { ...reservation, status: 'cancelled', expires_at: null },
          seatNumbers,
        );
      }),
    );
  }

  async findOwn(reservationId: string, userId: string): Promise<ReservationView> {
    const rows: ReservationRow[] = await this.dataSource.query(
      `SELECT id, show_id, user_id, status::text AS status, seat_count,
              amount_paise, expires_at, created_at
       FROM reservations WHERE id = $1`,
      [reservationId],
    );
    const reservation = rows[0];
    if (!reservation) throw DomainError.reservationNotFound(reservationId);
    if (reservation.user_id !== userId) {
      throw DomainError.notReservationOwner(reservationId);
    }
    const seats: Array<{ seat_number: string }> = await this.dataSource.query(
      `SELECT seat_number FROM reservation_seats WHERE reservation_id = $1
       ORDER BY seat_number ASC`,
      [reservationId],
    );
    return toView(
      reservation,
      seats.map((s) => s.seat_number),
    );
  }

  // ---------------------------------------------------------------------------
  // EXPIRY SWEEP
  // ---------------------------------------------------------------------------
  /**
   * SKIP LOCKED throughout: the sweeper must never block a buyer, and two
   * instances of it must never fight. Everything it does is guarded on
   * `status = 'held'`, so a hold confirmed a microsecond ago is left alone.
   */
  async sweepExpiredHolds(batch: number): Promise<{
    reservations: number;
    seats: number;
  }> {
    const rows: Array<{
      seats_released: string;
      reservations_expired: string;
    }> = await this.dataSource.query(
      `WITH expired AS (
           SELECT id FROM reservations
           WHERE status = 'held' AND expires_at IS NOT NULL AND expires_at < now()
           ORDER BY expires_at ASC
           LIMIT $1
           FOR UPDATE SKIP LOCKED
         ), released AS (
           UPDATE seats s
           SET status = 'available', reservation_id = NULL, owner_user_id = NULL,
               held_until = NULL, version = version + 1
           FROM expired e
           WHERE s.reservation_id = e.id AND s.status = 'held'
           RETURNING s.id
         ), closed AS (
           UPDATE reservations r
           SET status = 'expired', expires_at = NULL, updated_at = now()
           FROM expired e
           WHERE r.id = e.id AND r.status = 'held'
           RETURNING r.id
         )
         SELECT (SELECT count(*) FROM released)::text AS seats_released,
                (SELECT count(*) FROM closed)::text   AS reservations_expired`,
      [batch],
    );

    return {
      reservations: Number(rows[0]?.reservations_expired ?? 0),
      seats: Number(rows[0]?.seats_released ?? 0),
    };
  }

  // ---------------------------------------------------------------------------
  // internals
  // ---------------------------------------------------------------------------
  /**
   * Unlocked, transaction-free screening read covering the two declines that
   * dominate a burst: the seat is gone, or the caller is already at their
   * limit. One index-only round trip, no transaction, no lock.
   *
   * It can only ever produce a decline, which is what makes it safe. A stale
   * read can decline a seat that was freed microseconds ago, or a user who
   * cancelled concurrently; both cost that caller one retry. It can never
   * allocate anything, so it cannot double-sell and cannot let a user past
   * their limit -- those decisions still belong to the transaction.
   */
  private async precheck(
    showId: string,
    userId: string,
    seats: string[],
  ): Promise<void> {
    const rows: Array<{
      seat_number: string;
      status: string;
      user_held: number;
      per_user_limit: number;
    }> = await this.dataSource.query(
      `SELECT s.seat_number,
              s.status::text AS status,
              (SELECT count(*)::int FROM seats q
                WHERE q.show_id = $1 AND q.owner_user_id = $3
                  AND q.status <> 'available') AS user_held,
              (SELECT per_user_limit FROM shows WHERE id = $1) AS per_user_limit
       FROM seats s
       WHERE s.show_id = $1 AND s.seat_number = ANY($2::text[])`,
      [showId, seats, userId],
    );

    // No rows means either an unknown show or unknown seats. Both are resolved
    // authoritatively inside the transaction, so fall through rather than
    // guessing which one it was.
    if (rows.length === 0) return;

    if (rows.length !== seats.length) {
      const found = new Set(rows.map((r) => r.seat_number));
      throw DomainError.seatNotFound(seats.filter((s) => !found.has(s)));
    }

    const taken = rows
      .filter((r) => r.status !== 'available')
      .map((r) => r.seat_number)
      .sort();
    if (taken.length > 0) throw DomainError.seatTaken(taken);

    const { user_held: held, per_user_limit: limit } = rows[0];
    if (limit != null && held + seats.length > limit) {
      throw DomainError.perUserLimit(limit, held, seats.length);
    }
  }

  private async lockOwnReservation(
    manager: EntityManager,
    reservationId: string,
    userId: string,
  ): Promise<ReservationRow> {
    // Read unlocked first, purely to learn the show id so the advisory lock can
    // be taken before any row lock. That keeps the global lock order the same
    // as reserve's: advisory(show, user) -> seat rows ascending.
    const peek: Array<{ show_id: string; user_id: string }> = await manager.query(
      `SELECT show_id, user_id FROM reservations WHERE id = $1`,
      [reservationId],
    );
    if (peek.length === 0) throw DomainError.reservationNotFound(reservationId);
    if (peek[0].user_id !== userId) {
      throw DomainError.notReservationOwner(reservationId);
    }

    await manager.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1 || ':' || $2, 0))`,
      [peek[0].show_id, userId],
    );

    const rows: ReservationRow[] = await manager.query(
      `SELECT id, show_id, user_id, status::text AS status, seat_count,
              amount_paise, expires_at, created_at
       FROM reservations WHERE id = $1 FOR UPDATE`,
      [reservationId],
    );
    if (rows.length === 0) throw DomainError.reservationNotFound(reservationId);
    // Re-check ownership against the locked row, not the unlocked peek.
    if (rows[0].user_id !== userId) {
      throw DomainError.notReservationOwner(reservationId);
    }
    return rows[0];
  }

  private async seatNumbersOf(
    manager: EntityManager,
    reservationId: string,
  ): Promise<string[]> {
    const rows: Array<{ seat_number: string }> = await manager.query(
      `SELECT seat_number FROM reservation_seats WHERE reservation_id = $1
       ORDER BY seat_number ASC`,
      [reservationId],
    );
    return rows.map((r) => r.seat_number);
  }

  private async viewOf(
    manager: EntityManager,
    reservation: ReservationRow,
  ): Promise<ReservationView> {
    return toView(reservation, await this.seatNumbersOf(manager, reservation.id));
  }

  /**
   * Retries only the Postgres states that mean "contention, try again"
   * (40001/40P01/55P03). A DomainError is a decision, never retried. Anything
   * else is a real fault and is allowed to propagate.
   */
  private async withRetry<T>(op: string, fn: () => Promise<T>): Promise<T> {
    let attempt = 0;
    for (;;) {
      try {
        return await fn();
      } catch (err) {
        if (err instanceof DomainError) throw err;
        if (!isRetryable(err) || attempt >= this.cfg.resilience.txMaxRetries) {
          throw err;
        }
        const code = sqlState(err) ?? 'unknown';
        this.metrics.txRetries.inc({ sqlstate: code });
        attempt += 1;
        // Full jitter: two transactions that just deadlocked should not wake up
        // together and do it again.
        const backoff = Math.random() * 5 * 2 ** attempt;
        log({ op, attempt, sqlstate: code }).warn('retrying after contention');
        await new Promise((resolve) => setTimeout(resolve, backoff));
      }
    }
  }
}

const toView = (
  reservation: Omit<ReservationRow, 'created_at'> & { created_at: Date },
  seats: string[],
): ReservationView => ({
  reservation_id: reservation.id,
  show_id: reservation.show_id,
  user_id: reservation.user_id,
  seats,
  amount_paise: Number(reservation.amount_paise),
  status: reservation.status,
  expires_at: reservation.expires_at
    ? new Date(reservation.expires_at).toISOString()
    : null,
  created_at: new Date(reservation.created_at).toISOString(),
});
