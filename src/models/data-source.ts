import { config as loadEnv } from 'dotenv';
import { DataSource, DataSourceOptions } from 'typeorm';
import { loadConfig } from '../config/configuration';
import {
  IdempotencyKeyEntity,
  ReservationEntity,
  ReservationSeatEntity,
  SeatEntity,
  ShowEntity,
} from './entities';
import { InitialSchema1759300000000 } from './migrations/1759300000000-InitialSchema';

loadEnv();

export const buildDataSourceOptions = (): DataSourceOptions => {
  const config = loadConfig();

  return {
    type: 'postgres',
    url: config.database.url,
    ssl: config.database.ssl ? { rejectUnauthorized: false } : false,
    entities: [
      ShowEntity,
      SeatEntity,
      ReservationEntity,
      ReservationSeatEntity,
      IdempotencyKeyEntity,
    ],
    migrations: [InitialSchema1759300000000],
    migrationsRun: false,
    // Never. The schema is owned by migrations so a clean checkout and the
    // deployed instance get byte-identical DDL, including the CHECK
    // constraints that `synchronize` would quietly skip.
    synchronize: false,
    logging: config.env === 'development' ? ['error', 'warn'] : ['error'],
    extra: {
      max: config.database.poolMax,
      min: config.database.poolMin,
      connectionTimeoutMillis: config.database.connectionTimeoutMs,
      // A reservation is a handful of indexed statements. If one runs longer
      // than this something is pathologically wrong, and holding a pool slot
      // hostage hurts every other buyer more than failing fast does.
      statement_timeout: config.database.statementTimeoutMs,
      idle_in_transaction_session_timeout: config.database.idleInTxTimeoutMs,
      application_name: 'seat-reservation-service',
      keepAlive: true,
    },
  };
};

export const AppDataSource = new DataSource(buildDataSourceOptions());
export default AppDataSource;
