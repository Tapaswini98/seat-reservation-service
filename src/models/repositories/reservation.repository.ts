import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { loadConfig } from '../../config/configuration';
import { ReservationEntity } from '../entities/reservation.entity';
import { IdempotencyKeyRepository } from './idempotency-key.repository';
import { SeatRepository } from './seat.repository';
import { MetricsService } from '../../modules/metrics/metrics.service';
import { ReservationStatus } from '../../shared/enums/reservation.enum';
import { SeatStatus } from '../../shared/enums/seat.enum';
import { DomainException } from '../../shared/exceptions/domain.exception';
import { isRetryable, sqlState } from '../../shared/helpers/pg-error.helper';
import { rowsOf } from '../../shared/helpers/pg-result.helper';
import { log } from '../../shared/logger/logger';
import {
  ReservationView,
  ReserveSeatsCommand,
  SweepResult,
} from '../../modules/reservation/interfaces';

interface ShowPricingRow {
  id: string;
  price_paise: string;
  per_user_limit: number;
}

interface LockedSeatRow {
  id: string;
  seat_number: string;
  status: SeatStatus;
}

interface ReservationRow {
  id: string;
  show_id: string;
  user_id: string;
  status: ReservationStatus;
  seat_count: number;
  amount_paise: string;
  expires_at: Date | null;
  created_at: Date;
}

@Injectable()
export class ReservationRepository extends Repository<ReservationEntity> {
  private readonly config = loadConfig();

  constructor(
    private readonly dataSource: DataSource,
    private readonly seatRepository: SeatRepository,
    private readonly idempotencyKeyRepository: IdempotencyKeyRepository,
    private readonly metricsService: MetricsService,
  ) {
    super(ReservationEntity, dataSource.createEntityManager());
  }

  // ---------------------------------------------------------------------------
  // RESERVE -- the atomic decision
  // ---------------------------------------------------------------------------
  /**
   * One transaction at READ COMMITTED. Three independent mechanisms make a
   * double-sell impossible, strongest first:
   *
   *   1. The guarded UPDATE is a compare-and-swap: `WHERE status='available'`.
   *      Under READ COMMITTED a writer that blocks on a concurrently-updated
   *      row re-evaluates its WHERE clause against the committed version once
   *      the other transaction ends, so two transactions cannot both get a row
   *      back from it. This is the actual guarantee; everything else exists to
   *      make the loser's experience good, not the winner's correctness.
   *   2. The SELECT ... FOR UPDATE takes the row locks up front, so a loser
   *      that got past the fast path blocks and then reads a real status,
   *      declining with a precise reason instead of inferring one from a row
   *      count.
   *   3. One row per (show, seat_number), enforced by a unique constraint.
   *      There is no arrangement of this data in which a seat is owned twice.
   *
   * Deadlock: the only multi-row lock set is the seat SELECT, always acquired
   * `ORDER BY seat_number ASC`. Postgres puts the LockRows node above the
   * Sort, so locks really are taken in sorted order, and confirm/cancel use
   * the same order. The global order is advisory(show,user) -> seats
   * ascending, which admits no cycle. 40P01/40001 are still retried as
   * defence in depth.
   */
  async reserveSeats(command: ReserveSeatsCommand): Promise<ReservationView> {
    const seatNumbers = [...new Set(command.seatNumbers)].sort();
    if (seatNumbers.length !== command.seatNumbers.length) {
      throw DomainException.validation('seats contains duplicate labels');
    }
    if (seatNumbers.length > this.config.domain.maxSeatsPerReservation) {
      throw DomainException.validation(
        `at most ${this.config.domain.maxSeatsPerReservation} seats per request`,
      );
    }

    // Lock-free screening read. Declines only; see SeatRepository.precheckOrThrow.
    await this.seatRepository.precheckOrThrow(
      command.showId,
      command.userId,
      seatNumbers,
    );

    return this.runWithContentionRetry('reserveSeats', () =>
      this.dataSource.transaction(async (manager) => {
        const show = await this.lockUserQuotaAndLoadShow(
          manager,
          command.showId,
          command.userId,
        );
        const lockedSeats = await this.lockSeats(manager, command.showId, seatNumbers);

        // All-or-nothing. A request for [A12, A13] where only A12 is free
        // reserves NOTHING and reports exactly which seats blocked it.
        // Best-effort would make the amount charged depend on who won a race,
        // which is a terrible property for something that takes money.
        const taken = lockedSeats
          .filter((seat) => seat.status !== SeatStatus.Available)
          .map((seat) => seat.seat_number);
        if (taken.length > 0) throw DomainException.seatTaken(taken);

        const alreadyHeld = await this.countUserSeatsInTransaction(
          manager,
          command.showId,
          command.userId,
        );
        if (alreadyHeld + seatNumbers.length > show.per_user_limit) {
          throw DomainException.perUserLimit(
            show.per_user_limit,
            alreadyHeld,
            seatNumbers.length,
          );
        }

        const reservation = await this.insertReservation(manager, {
          showId: command.showId,
          userId: command.userId,
          isHold: command.holdSeconds !== undefined,
          holdSeconds: command.holdSeconds,
          seatCount: seatNumbers.length,
          // Money stays in integer paise end to end: BigInt multiplication,
          // never a float.
          amountPaise: (
            BigInt(show.price_paise) * BigInt(seatNumbers.length)
          ).toString(),
        });

        await manager.query(
          `INSERT INTO reservation_seats (reservation_id, seat_id, seat_number)
           SELECT $1, s.id, s.seat_number
           FROM seats s WHERE s.id = ANY($2::uuid[])`,
          [reservation.id, lockedSeats.map((seat) => seat.id)],
        );

        await this.allocateSeats(manager, {
          showId: command.showId,
          seatNumbers,
          reservation,
          userId: command.userId,
          isHold: command.holdSeconds !== undefined,
        });

        const view = toReservationView(reservation, seatNumbers);

        if (command.idempotencyKeyId) {
          await this.idempotencyKeyRepository.markCompletedInTransaction(manager, {
            keyId: command.idempotencyKeyId,
            httpStatus: 201,
            response: view as unknown as Record<string, unknown>,
            reservationId: reservation.id,
          });
        }

        return view;
      }),
    );
  }

  // ---------------------------------------------------------------------------
  // CONFIRM -- promote a hold
  // ---------------------------------------------------------------------------
  async confirmReservation(
    reservationId: string,
    userId: string,
  ): Promise<ReservationView> {
    return this.runWithContentionRetry('confirmReservation', () =>
      this.dataSource.transaction(async (manager) => {
        const reservation = await this.lockOwnReservation(
          manager,
          reservationId,
          userId,
        );

        // Confirming twice is a no-op, not an error.
        if (reservation.status === ReservationStatus.Confirmed) {
          return this.toViewWithSeats(manager, reservation);
        }
        if (reservation.status === ReservationStatus.Expired) {
          throw DomainException.reservationExpired();
        }
        if (reservation.status !== ReservationStatus.Held) {
          throw DomainException.reservationNotHeld(reservation.status);
        }
        if (reservation.expires_at && reservation.expires_at.getTime() <= Date.now()) {
          throw DomainException.reservationExpired();
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
          throw DomainException.reservationExpired();
        }

        await manager.query(
          `UPDATE reservations
           SET status = 'confirmed', expires_at = NULL, updated_at = now()
           WHERE id = $1`,
          [reservation.id],
        );

        return toReservationView(
          {
            ...reservation,
            status: ReservationStatus.Confirmed,
            expires_at: null,
          },
          promoted.map((row) => row.seat_number).sort(),
        );
      }),
    );
  }

  // ---------------------------------------------------------------------------
  // CANCEL -- release without ever resurrecting someone else's seat
  // ---------------------------------------------------------------------------
  async cancelReservation(
    reservationId: string,
    userId: string,
  ): Promise<ReservationView> {
    return this.runWithContentionRetry('cancelReservation', () =>
      this.dataSource.transaction(async (manager) => {
        const reservation = await this.lockOwnReservation(
          manager,
          reservationId,
          userId,
        );

        if (
          reservation.status === ReservationStatus.Cancelled ||
          reservation.status === ReservationStatus.Expired
        ) {
          return this.toViewWithSeats(manager, reservation);
        }

        const seatNumbers = await this.findSeatNumbers(manager, reservation.id);

        // Same ascending lock order as reserve, so a cancel and a reserve
        // touching overlapping seats can queue but cannot deadlock.
        await manager.query(
          `SELECT id FROM seats
           WHERE reservation_id = $1
           ORDER BY seat_number ASC
           FOR UPDATE`,
          [reservation.id],
        );

        // `WHERE reservation_id = $1` is the clause that makes a release
        // safe: it can only ever free seats that still belong to THIS
        // reservation. A seat already re-sold carries a different
        // reservation_id and is simply not matched, so a late cancel can
        // never resurrect it.
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
          `UPDATE reservations
           SET status = 'cancelled', expires_at = NULL, updated_at = now()
           WHERE id = $1`,
          [reservation.id],
        );

        log({
          reservation_id: reservation.id,
          seats_released: released.length,
        }).info('reservation cancelled');

        return toReservationView(
          {
            ...reservation,
            status: ReservationStatus.Cancelled,
            expires_at: null,
          },
          seatNumbers,
        );
      }),
    );
  }

  async findOwnedById(reservationId: string, userId: string): Promise<ReservationView> {
    const rows: ReservationRow[] = await this.dataSource.query(
      `SELECT id, show_id, user_id, status::text AS status, seat_count,
              amount_paise, expires_at, created_at
       FROM reservations WHERE id = $1`,
      [reservationId],
    );
    const reservation = rows[0];
    if (!reservation) throw DomainException.reservationNotFound(reservationId);
    if (reservation.user_id !== userId) {
      throw DomainException.notReservationOwner(reservationId);
    }

    const seats: Array<{ seat_number: string }> = await this.dataSource.query(
      `SELECT seat_number FROM reservation_seats WHERE reservation_id = $1
       ORDER BY seat_number ASC`,
      [reservationId],
    );
    return toReservationView(
      reservation,
      seats.map((row) => row.seat_number),
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
  async sweepExpiredHolds(batchSize: number): Promise<SweepResult> {
    const rows: Array<{ seats_released: string; reservations_expired: string }> =
      await this.dataSource.query(
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
        [batchSize],
      );

    return {
      reservations: Number(rows[0]?.reservations_expired ?? 0),
      seats: Number(rows[0]?.seats_released ?? 0),
    };
  }

  // ---------------------------------------------------------------------------
  // transaction steps
  // ---------------------------------------------------------------------------
  /**
   * Takes the per-(show, user) advisory lock and reads the show in a single
   * round trip. The lock function sits in the target list, so it is evaluated
   * per output row: an unknown show produces no rows and therefore takes no
   * lock, which is exactly what we want.
   *
   * Why an advisory lock at all -- row locks on seats do nothing for the
   * per-user limit, because two parallel requests for *different* seats would
   * both read "3 held" and both insert. This is what makes the quota check
   * sound. It is transaction-scoped, so there is no unlock call to leak on an
   * error path, and because the key is per-user the 20k-distinct-buyers case
   * never contends on it.
   */
  private async lockUserQuotaAndLoadShow(
    manager: EntityManager,
    showId: string,
    userId: string,
  ): Promise<ShowPricingRow> {
    const rows: ShowPricingRow[] = await manager.query(
      `SELECT id, price_paise, per_user_limit
       FROM shows
       WHERE id = $1
         AND pg_advisory_xact_lock(hashtextextended($1 || ':' || $2, 0)) IS NOT NULL`,
      [showId, userId],
    );
    if (rows.length === 0) throw DomainException.showNotFound(showId);
    return rows[0];
  }

  private async lockSeats(
    manager: EntityManager,
    showId: string,
    seatNumbers: string[],
  ): Promise<LockedSeatRow[]> {
    const locked: LockedSeatRow[] = await manager.query(
      `SELECT id, seat_number, status::text AS status
       FROM seats
       WHERE show_id = $1 AND seat_number = ANY($2::text[])
       ORDER BY seat_number ASC
       FOR UPDATE`,
      [showId, seatNumbers],
    );

    const found = new Set(locked.map((seat) => seat.seat_number));
    const unknown = seatNumbers.filter((seat) => !found.has(seat));
    if (unknown.length > 0) throw DomainException.seatNotFound(unknown);

    return locked;
  }

  private async countUserSeatsInTransaction(
    manager: EntityManager,
    showId: string,
    userId: string,
  ): Promise<number> {
    const rows: Array<{ held: number }> = await manager.query(
      `SELECT count(*)::int AS held
       FROM seats
       WHERE show_id = $1 AND owner_user_id = $2 AND status <> 'available'`,
      [showId, userId],
    );
    return rows[0]?.held ?? 0;
  }

  private async insertReservation(
    manager: EntityManager,
    params: {
      showId: string;
      userId: string;
      isHold: boolean;
      holdSeconds?: number;
      seatCount: number;
      amountPaise: string;
    },
  ): Promise<ReservationRow> {
    const created: ReservationRow[] = await manager.query(
      `INSERT INTO reservations
         (show_id, user_id, status, seat_count, amount_paise, expires_at)
       VALUES ($1, $2, $3::reservation_status, $4, $5,
               CASE WHEN $6::int IS NULL THEN NULL
                    ELSE now() + make_interval(secs => $6::int) END)
       RETURNING id, show_id, user_id, status::text AS status, seat_count,
                 amount_paise, expires_at, created_at`,
      [
        params.showId,
        params.userId,
        params.isHold ? ReservationStatus.Held : ReservationStatus.Confirmed,
        params.seatCount,
        params.amountPaise,
        params.holdSeconds ?? null,
      ],
    );
    return created[0];
  }

  /**
   * The compare-and-swap. `AND status = 'available'` is the guard that
   * actually prevents the double-sell; the RETURNING row count is how we
   * verify it fired for every seat. Unreachable given the row locks already
   * held, which is exactly why it is here: if the lock reasoning is ever
   * wrong, this rolls back instead of selling a seat twice.
   */
  private async allocateSeats(
    manager: EntityManager,
    params: {
      showId: string;
      seatNumbers: string[];
      reservation: ReservationRow;
      userId: string;
      isHold: boolean;
    },
  ): Promise<void> {
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
          params.showId,
          params.seatNumbers,
          params.isHold ? SeatStatus.Held : SeatStatus.Confirmed,
          params.reservation.id,
          params.userId,
          params.isHold ? params.reservation.expires_at : null,
        ],
      ),
    );

    if (updated.length !== params.seatNumbers.length) {
      log({
        show_id: params.showId,
        seats: params.seatNumbers,
        expected: params.seatNumbers.length,
        updated: updated.length,
      }).warn('conditional seat update matched fewer rows than were locked');
      throw DomainException.seatTaken(params.seatNumbers);
    }
  }

  private async lockOwnReservation(
    manager: EntityManager,
    reservationId: string,
    userId: string,
  ): Promise<ReservationRow> {
    // Read unlocked first, purely to learn the show id so the advisory lock
    // can be taken before any row lock. That keeps the global lock order the
    // same as reserve's: advisory(show, user) -> seat rows ascending.
    const peek: Array<{ show_id: string; user_id: string }> = await manager.query(
      `SELECT show_id, user_id FROM reservations WHERE id = $1`,
      [reservationId],
    );
    if (peek.length === 0) throw DomainException.reservationNotFound(reservationId);
    if (peek[0].user_id !== userId) {
      throw DomainException.notReservationOwner(reservationId);
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
    if (rows.length === 0) throw DomainException.reservationNotFound(reservationId);
    // Re-check ownership against the locked row, not the unlocked peek.
    if (rows[0].user_id !== userId) {
      throw DomainException.notReservationOwner(reservationId);
    }
    return rows[0];
  }

  private async findSeatNumbers(
    manager: EntityManager,
    reservationId: string,
  ): Promise<string[]> {
    const rows: Array<{ seat_number: string }> = await manager.query(
      `SELECT seat_number FROM reservation_seats WHERE reservation_id = $1
       ORDER BY seat_number ASC`,
      [reservationId],
    );
    return rows.map((row) => row.seat_number);
  }

  private async toViewWithSeats(
    manager: EntityManager,
    reservation: ReservationRow,
  ): Promise<ReservationView> {
    return toReservationView(
      reservation,
      await this.findSeatNumbers(manager, reservation.id),
    );
  }

  /**
   * Retries only the Postgres states that mean "contention, try again"
   * (40001/40P01/55P03). A DomainException is a decision and is never
   * retried; anything else is a real fault and is allowed to propagate.
   */
  private async runWithContentionRetry<T>(
    operation: string,
    work: () => Promise<T>,
  ): Promise<T> {
    let attempt = 0;
    for (;;) {
      try {
        return await work();
      } catch (err) {
        if (err instanceof DomainException) throw err;
        if (!isRetryable(err) || attempt >= this.config.resilience.txMaxRetries) {
          throw err;
        }

        const code = sqlState(err) ?? 'unknown';
        this.metricsService.txRetries.inc({ sqlstate: code });
        attempt += 1;
        // Full jitter: two transactions that just deadlocked should not wake
        // up together and do it again.
        const backoffMs = Math.random() * 5 * 2 ** attempt;
        log({ operation, attempt, sqlstate: code }).warn('retrying after contention');
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      }
    }
  }
}

const toReservationView = (
  reservation: ReservationRow,
  seatNumbers: string[],
): ReservationView => ({
  reservation_id: reservation.id,
  show_id: reservation.show_id,
  user_id: reservation.user_id,
  seats: seatNumbers,
  amount_paise: Number(reservation.amount_paise),
  status: reservation.status,
  expires_at: reservation.expires_at
    ? new Date(reservation.expires_at).toISOString()
    : null,
  created_at: new Date(reservation.created_at).toISOString(),
});
