import { DataSource, DataSourceOptions } from 'typeorm';
import { config as loadEnv } from 'dotenv';
import { loadConfig } from '../config/configuration';
import { IdempotencyKey, Reservation, ReservationSeat, Seat, Show } from '../entities';
import { InitialSchema1759300000000 } from '../migrations/1759300000000-InitialSchema';

loadEnv();

export const buildDataSourceOptions = (): DataSourceOptions => {
  const cfg = loadConfig();
  return {
    type: 'postgres',
    url: cfg.database.url,
    ssl: cfg.database.ssl ? { rejectUnauthorized: false } : false,
    entities: [Show, Seat, Reservation, ReservationSeat, IdempotencyKey],
    migrations: [InitialSchema1759300000000],
    migrationsRun: false,
    // Never. The schema is owned by migrations so a clean checkout and the
    // deployed instance get byte-identical DDL.
    synchronize: false,
    logging: cfg.env === 'development' ? ['error', 'warn'] : ['error'],
    extra: {
      max: cfg.database.poolMax,
      min: cfg.database.poolMin,
      connectionTimeoutMillis: cfg.database.connectionTimeoutMs,
      // A reservation transaction is a handful of indexed statements. If one
      // runs longer than this something is pathologically wrong and holding a
      // pool slot hostage hurts every other buyer more than failing fast does.
      statement_timeout: cfg.database.statementTimeoutMs,
      idle_in_transaction_session_timeout: cfg.database.idleInTxTimeoutMs,
      application_name: 'seat-reservation-service',
      keepAlive: true,
    },
  };
};

export const AppDataSource = new DataSource(buildDataSourceOptions());
export default AppDataSource;
