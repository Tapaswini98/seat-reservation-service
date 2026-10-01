const int = (value: string | undefined, fallback: number): number => {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const bool = (value: string | undefined, fallback: boolean): boolean => {
  if (value === undefined || value === '') return fallback;
  return value === 'true' || value === '1';
};

export interface AppConfig {
  env: string;
  port: number;
  logLevel: string;
  logSampleRate: number;
  database: {
    url: string;
    ssl: boolean;
    poolMax: number;
    poolMin: number;
    connectionTimeoutMs: number;
    statementTimeoutMs: number;
    idleInTxTimeoutMs: number;
  };
  auth: {
    jwtSecret: string;
    jwtExpiresIn: string;
    adminToken: string;
  };
  domain: {
    defaultPerUserLimit: number;
    defaultHoldSeconds: number;
    maxHoldSeconds: number;
    maxSeatsPerShow: number;
    maxSeatsPerReservation: number;
    idempotencyTtlHours: number;
    idempotencyWaitMs: number;
  };
  resilience: {
    txMaxRetries: number;
    expirySweepIntervalMs: number;
    expirySweepBatch: number;
  };
}

export const loadConfig = (): AppConfig => ({
  env: process.env.NODE_ENV ?? 'development',
  port: int(process.env.PORT, 3000),
  logLevel: process.env.LOG_LEVEL ?? 'info',
  logSampleRate: int(process.env.LOG_SAMPLE_RATE, 20),
  database: {
    url:
      process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5433/seats',
    ssl: bool(process.env.DATABASE_SSL, false),
    poolMax: int(process.env.DB_POOL_MAX, 15),
    poolMin: int(process.env.DB_POOL_MIN, 2),
    connectionTimeoutMs: int(process.env.DB_CONNECTION_TIMEOUT_MS, 10000),
    statementTimeoutMs: int(process.env.DB_STATEMENT_TIMEOUT_MS, 3000),
    idleInTxTimeoutMs: int(process.env.DB_IDLE_IN_TX_TIMEOUT_MS, 5000),
  },
  auth: {
    jwtSecret: process.env.JWT_SECRET ?? 'dev-only-change-me',
    jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? '24h',
    adminToken: process.env.ADMIN_TOKEN ?? 'dev-admin-token',
  },
  domain: {
    defaultPerUserLimit: int(process.env.DEFAULT_PER_USER_LIMIT, 4),
    defaultHoldSeconds: int(process.env.DEFAULT_HOLD_SECONDS, 120),
    maxHoldSeconds: int(process.env.MAX_HOLD_SECONDS, 900),
    maxSeatsPerShow: int(process.env.MAX_SEATS_PER_SHOW, 20000),
    maxSeatsPerReservation: int(process.env.MAX_SEATS_PER_RESERVATION, 10),
    idempotencyTtlHours: int(process.env.IDEMPOTENCY_TTL_HOURS, 24),
    idempotencyWaitMs: int(process.env.IDEMPOTENCY_WAIT_MS, 2000),
  },
  resilience: {
    txMaxRetries: int(process.env.TX_MAX_RETRIES, 3),
    expirySweepIntervalMs: int(process.env.EXPIRY_SWEEP_INTERVAL_MS, 5000),
    expirySweepBatch: int(process.env.EXPIRY_SWEEP_BATCH, 500),
  },
});

export type ConfigKey = keyof AppConfig;
