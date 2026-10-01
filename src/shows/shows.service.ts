import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { loadConfig } from '../config/configuration';
import { DomainError } from '../common/errors/domain-error';
import { isUniqueViolation } from '../common/errors/pg-errors';
import { log } from '../common/logging/logger';
import { CreateShowDto } from './dto/create-show.dto';

export interface SeatView {
  seat_number: string;
  status: 'available' | 'held' | 'confirmed';
  held_until: string | null;
}

export interface ShowStateView {
  id: string;
  name: string;
  price_paise: number;
  per_user_limit: number;
  total_seats: number;
  counts: {
    available: number;
    held: number;
    confirmed: number;
    total: number;
  };
  reconciled: boolean;
  seats: SeatView[];
}

@Injectable()
export class ShowsService {
  private readonly cfg = loadConfig();

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async create(dto: CreateShowDto): Promise<ShowStateView> {
    const seats = dedupe(dto.seats);
    if (seats.length === 0) {
      throw DomainError.validation('seats must contain at least one label');
    }
    if (seats.length !== dto.seats.length) {
      throw DomainError.validation('seats contains duplicate labels', {
        provided: dto.seats.length,
        distinct: seats.length,
      });
    }
    if (seats.length > this.cfg.domain.maxSeatsPerShow) {
      throw DomainError.validation(
        `a show may have at most ${this.cfg.domain.maxSeatsPerShow} seats`,
      );
    }

    const perUserLimit = dto.per_user_limit ?? this.cfg.domain.defaultPerUserLimit;

    const showId = await this.dataSource.transaction(async (manager) => {
      let inserted: Array<{ id: string }>;
      try {
        inserted = await manager.query(
          `INSERT INTO shows (name, price_paise, per_user_limit, total_seats)
           VALUES ($1, $2, $3, $4)
           RETURNING id`,
          [dto.name, String(dto.price_paise), perUserLimit, seats.length],
        );
      } catch (err) {
        if (isUniqueViolation(err)) throw DomainError.showNameTaken(dto.name);
        throw err;
      }

      const id = inserted[0].id;
      // One multi-row INSERT rather than N statements: a 20k-seat hall is a
      // single round trip and a single WAL flush.
      await manager.query(
        `INSERT INTO seats (show_id, seat_number)
         SELECT $1, label FROM unnest($2::text[]) AS label`,
        [id, seats],
      );
      return id;
    });

    log({ show_id: showId, seats: seats.length }).info('show created');
    const view = await this.getState(showId);
    return view;
  }

  async getState(showId: string): Promise<ShowStateView> {
    if (!isUuid(showId)) throw DomainError.showNotFound(showId);

    const shows: Array<{
      id: string;
      name: string;
      price_paise: string;
      per_user_limit: number;
      total_seats: number;
    }> = await this.dataSource.query(
      `SELECT id, name, price_paise, per_user_limit, total_seats
       FROM shows WHERE id = $1`,
      [showId],
    );
    if (shows.length === 0) throw DomainError.showNotFound(showId);
    const show = shows[0];

    const rows: Array<{
      seat_number: string;
      status: SeatView['status'];
      held_until: Date | null;
    }> = await this.dataSource.query(
      `SELECT seat_number, status::text AS status, held_until
       FROM seats WHERE show_id = $1
       ORDER BY seat_number ASC`,
      [showId],
    );

    const counts = { available: 0, held: 0, confirmed: 0, total: rows.length };
    for (const row of rows) counts[row.status] += 1;

    // The invariant is asserted on the way out, not merely documented. If the
    // three buckets ever fail to add up to the declared total we would rather
    // find out from this endpoint than from a customer with two tickets.
    const reconciled =
      counts.available + counts.held + counts.confirmed === show.total_seats;
    if (!reconciled) {
      log({ show_id: showId, counts, total_seats: show.total_seats }).error(
        'RECONCILIATION VIOLATION: seat states do not sum to total_seats',
      );
    }

    return {
      id: show.id,
      name: show.name,
      price_paise: Number(show.price_paise),
      per_user_limit: show.per_user_limit,
      total_seats: show.total_seats,
      counts,
      reconciled,
      seats: rows.map((row) => ({
        seat_number: row.seat_number,
        status: row.status,
        held_until: row.held_until ? row.held_until.toISOString() : null,
      })),
    };
  }
}

const dedupe = (values: string[]): string[] => [...new Set(values)];

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const isUuid = (value: string): boolean => UUID_RE.test(value);
