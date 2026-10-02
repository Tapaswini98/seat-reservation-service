import { Injectable } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import { ShowEntity } from '../entities/show.entity';
import { SeatStatus } from '../../shared/enums/seat.enum';
import { DomainException } from '../../shared/exceptions/domain.exception';
import { isUniqueViolation } from '../../shared/helpers/pg-error.helper';

export interface ShowSummaryRow {
  id: string;
  name: string;
  price_paise: string;
  per_user_limit: number;
  total_seats: number;
}

export interface SeatStateRow {
  seat_number: string;
  status: SeatStatus;
  held_until: Date | null;
}

export interface ShowSeatCountRow {
  show_id: string;
  show_name: string;
  total_seats: number;
  status: SeatStatus;
  count: string;
}

@Injectable()
export class ShowRepository extends Repository<ShowEntity> {
  constructor(private readonly dataSource: DataSource) {
    super(ShowEntity, dataSource.createEntityManager());
  }

  /**
   * Creates the show and every seat row in one transaction, so a show can
   * never exist with a partial seat map -- which would break the
   * reconciliation invariant from the moment it was created.
   */
  async createWithSeats(params: {
    name: string;
    pricePaise: number;
    perUserLimit: number;
    seatNumbers: string[];
  }): Promise<string> {
    return this.dataSource.transaction(async (manager) => {
      let inserted: Array<{ id: string }>;
      try {
        inserted = await manager.query(
          `INSERT INTO shows (name, price_paise, per_user_limit, total_seats)
           VALUES ($1, $2, $3, $4)
           RETURNING id`,
          [
            params.name,
            String(params.pricePaise),
            params.perUserLimit,
            params.seatNumbers.length,
          ],
        );
      } catch (err) {
        if (isUniqueViolation(err)) throw DomainException.showNameTaken(params.name);
        throw err;
      }

      const showId = inserted[0].id;
      // One multi-row INSERT rather than N statements: a 20k-seat hall is a
      // single round trip and a single WAL flush.
      await manager.query(
        `INSERT INTO seats (show_id, seat_number)
         SELECT $1, label FROM unnest($2::text[]) AS label`,
        [showId, params.seatNumbers],
      );

      return showId;
    });
  }

  async findSummaryById(showId: string): Promise<ShowSummaryRow | null> {
    const rows: ShowSummaryRow[] = await this.dataSource.query(
      `SELECT id, name, price_paise, per_user_limit, total_seats
       FROM shows WHERE id = $1`,
      [showId],
    );
    return rows[0] ?? null;
  }

  async findSeatStates(showId: string): Promise<SeatStateRow[]> {
    return this.dataSource.query(
      `SELECT seat_number, status::text AS status, held_until
       FROM seats WHERE show_id = $1
       ORDER BY seat_number ASC`,
      [showId],
    );
  }

  /**
   * Seat counts grouped by status for the most recently created shows. Backs
   * the Prometheus gauges, which are derived at scrape time rather than
   * incremented alongside writes.
   */
  async countSeatsByStatusForRecentShows(limit: number): Promise<ShowSeatCountRow[]> {
    return this.dataSource.query(
      `WITH recent AS (
         SELECT id, name, total_seats
         FROM shows
         ORDER BY created_at DESC
         LIMIT $1
       )
       SELECT r.id AS show_id, r.name AS show_name, r.total_seats,
              s.status::text AS status, count(*)::text AS count
       FROM recent r
       JOIN seats s ON s.show_id = r.id
       GROUP BY r.id, r.name, r.total_seats, s.status`,
      [limit],
    );
  }
}
