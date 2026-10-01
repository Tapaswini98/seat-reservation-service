process.env.NODE_ENV = 'test';
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgres://postgres:postgres@localhost:55432/seats_test';
process.env.DATABASE_SSL = 'false';
process.env.JWT_SECRET = 'test-secret';
process.env.ADMIN_TOKEN = 'test-admin-token';
process.env.LOG_LEVEL = 'silent';
process.env.DB_POOL_MAX = '30';
process.env.EXPIRY_SWEEP_INTERVAL_MS = '500';

jest.setTimeout(60000);
