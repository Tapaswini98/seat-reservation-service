import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics,
} from 'prom-client';
import { DeclineReason } from '../common/errors/domain-error';

/** How many shows we expose per-show gauges for. Bounds label cardinality. */
const GAUGE_SHOW_LIMIT = 20;
/** Scrape-time gauge refresh is cached this long so a scrape storm can't add load. */
const GAUGE_CACHE_MS = 1000;

interface SeatCountRow {
  show_id: string;
  show_name: string;
  total_seats: number;
  status: string;
  count: string;
}

@Injectable()
export class MetricsService implements OnModuleInit {
  readonly registry = new Registry();

  readonly reservationsConfirmed: Counter<string>;
  readonly reservationsHeld: Counter<string>;
  readonly reservationsDeclined: Counter<'reason'>;
  readonly reservationsCancelled: Counter<string>;
  readonly holdsExpired: Counter<string>;
  readonly seatsSold: Counter<string>;
  readonly txRetries: Counter<'sqlstate'>;
  readonly httpRequests: Counter<'method' | 'route' | 'status'>;
  readonly serverErrors: Counter<'route'>;

  readonly reservationDuration: Histogram<'outcome'>;
  readonly httpDuration: Histogram<'method' | 'route' | 'status'>;

  readonly seatsAvailable: Gauge<'show_id' | 'show_name'>;
  readonly seatsHeld: Gauge<'show_id' | 'show_name'>;
  readonly seatsConfirmed: Gauge<'show_id' | 'show_name'>;
  readonly seatsTotal: Gauge<'show_id' | 'show_name'>;
  readonly reconciliationOk: Gauge<'show_id' | 'show_name'>;
  readonly dbPoolTotal: Gauge<string>;
  readonly dbPoolIdle: Gauge<string>;
  readonly dbPoolWaiting: Gauge<string>;

  private gaugeCacheAt = 0;
  private gaugeRefresh: Promise<void> | null = null;

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {
    const registers = [this.registry];

    this.reservationsConfirmed = new Counter({
      name: 'reservations_confirmed_total',
      help: 'Reservations that ended in a confirmed seat allocation',
      registers,
    });
    this.reservationsHeld = new Counter({
      name: 'reservations_held_total',
      help: 'Reservations created as time-boxed holds',
      registers,
    });
    this.reservationsDeclined = new Counter({
      name: 'reservations_declined_total',
      help: 'Reservation attempts declined, by domain reason',
      labelNames: ['reason'] as const,
      registers,
    });
    this.reservationsCancelled = new Counter({
      name: 'reservations_cancelled_total',
      help: 'Reservations cancelled by their owner',
      registers,
    });
    this.holdsExpired = new Counter({
      name: 'holds_expired_total',
      help: 'Holds released by the expiry sweeper',
      registers,
    });
    this.seatsSold = new Counter({
      name: 'seats_allocated_total',
      help: 'Individual seats allocated (held or confirmed)',
      registers,
    });
    this.txRetries = new Counter({
      name: 'reservation_tx_retries_total',
      help: 'Reservation transactions retried after a retryable Postgres error',
      labelNames: ['sqlstate'] as const,
      registers,
    });
    this.httpRequests = new Counter({
      name: 'http_requests_total',
      help: 'HTTP requests served',
      labelNames: ['method', 'route', 'status'] as const,
      registers,
    });
    this.serverErrors = new Counter({
      name: 'http_server_errors_total',
      help: 'Responses with a 5xx status. Must stay at zero during a burst.',
      labelNames: ['route'] as const,
      registers,
    });

    this.reservationDuration = new Histogram({
      name: 'reservation_duration_seconds',
      help: 'End-to-end reservation handling time',
      labelNames: ['outcome'] as const,
      buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
      registers,
    });
    this.httpDuration = new Histogram({
      name: 'http_request_duration_seconds',
      help: 'HTTP request duration',
      labelNames: ['method', 'route', 'status'] as const,
      buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
      registers,
    });

    const showLabels = ['show_id', 'show_name'] as const;
    this.seatsAvailable = new Gauge({
      name: 'seats_available',
      help: 'Seats currently available',
      labelNames: showLabels,
      registers,
    });
    this.seatsHeld = new Gauge({
      name: 'seats_held',
      help: 'Seats currently held',
      labelNames: showLabels,
      registers,
    });
    this.seatsConfirmed = new Gauge({
      name: 'seats_confirmed',
      help: 'Seats currently confirmed',
      labelNames: showLabels,
      registers,
    });
    this.seatsTotal = new Gauge({
      name: 'seats_total',
      help: 'Seats in the show',
      labelNames: showLabels,
      registers,
    });
    this.reconciliationOk = new Gauge({
      name: 'seats_reconciliation_ok',
      help: '1 when available + held + confirmed == total_seats, 0 otherwise',
      labelNames: showLabels,
      registers,
    });

    this.dbPoolTotal = new Gauge({
      name: 'db_pool_connections_total',
      help: 'Connections currently in the pg pool',
      registers,
    });
    this.dbPoolIdle = new Gauge({
      name: 'db_pool_connections_idle',
      help: 'Idle connections in the pg pool',
      registers,
    });
    this.dbPoolWaiting = new Gauge({
      name: 'db_pool_waiting_requests',
      help: 'Requests queued waiting for a pool connection',
      registers,
    });
  }

  onModuleInit(): void {
    collectDefaultMetrics({ register: this.registry, prefix: 'node_' });
  }

  declined(reason: DeclineReason): void {
    this.reservationsDeclined.inc({ reason });
  }

  /**
   * Gauges are derived from the database at scrape time rather than being
   * incremented alongside writes. That makes "metrics reconcile with the API"
   * true by construction: both read the same rows. A counter we remember to
   * decrement is a counter that eventually drifts.
   */
  async scrape(): Promise<string> {
    await this.refreshGauges();
    this.refreshPoolGauges();
    return this.registry.metrics();
  }

  private async refreshGauges(): Promise<void> {
    const now = Date.now();
    if (now - this.gaugeCacheAt < GAUGE_CACHE_MS) return;
    if (this.gaugeRefresh) return this.gaugeRefresh;

    this.gaugeRefresh = (async () => {
      try {
        const rows: SeatCountRow[] = await this.dataSource.query(
          `
          WITH recent AS (
            SELECT id, name, total_seats
            FROM shows
            ORDER BY created_at DESC
            LIMIT $1
          )
          SELECT r.id AS show_id, r.name AS show_name, r.total_seats,
                 s.status::text AS status, count(*)::text AS count
          FROM recent r
          JOIN seats s ON s.show_id = r.id
          GROUP BY r.id, r.name, r.total_seats, s.status
          `,
          [GAUGE_SHOW_LIMIT],
        );

        this.seatsAvailable.reset();
        this.seatsHeld.reset();
        this.seatsConfirmed.reset();
        this.seatsTotal.reset();
        this.reconciliationOk.reset();

        const totals = new Map<
          string,
          {
            name: string;
            declaredTotal: number;
            available: number;
            held: number;
            confirmed: number;
          }
        >();
        for (const row of rows) {
          const entry = totals.get(row.show_id) ?? {
            name: row.show_name,
            declaredTotal: Number(row.total_seats),
            available: 0,
            held: 0,
            confirmed: 0,
          };
          const count = Number(row.count);
          if (row.status === 'available') entry.available = count;
          else if (row.status === 'held') entry.held = count;
          else if (row.status === 'confirmed') entry.confirmed = count;
          totals.set(row.show_id, entry);
        }

        for (const [showId, t] of totals) {
          const labels = { show_id: showId, show_name: t.name };
          const summed = t.available + t.held + t.confirmed;
          this.seatsAvailable.set(labels, t.available);
          this.seatsHeld.set(labels, t.held);
          this.seatsConfirmed.set(labels, t.confirmed);
          this.seatsTotal.set(labels, t.declaredTotal);
          // Compared against the show's declared total, not against the sum of
          // the three buckets -- otherwise the check is circular and can never
          // fail. This catches a seat row that went missing or was duplicated.
          this.reconciliationOk.set(labels, summed === t.declaredTotal ? 1 : 0);
        }
        this.gaugeCacheAt = Date.now();
      } finally {
        this.gaugeRefresh = null;
      }
    })();

    return this.gaugeRefresh;
  }

  private refreshPoolGauges(): void {
    const pool = (this.dataSource.driver as { master?: unknown }).master as
      { totalCount?: number; idleCount?: number; waitingCount?: number } | undefined;
    if (!pool) return;
    this.dbPoolTotal.set(pool.totalCount ?? 0);
    this.dbPoolIdle.set(pool.idleCount ?? 0);
    this.dbPoolWaiting.set(pool.waitingCount ?? 0);
  }
}
