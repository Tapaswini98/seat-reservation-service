/**
 * Points the whole suite at a dedicated test database and brings its schema up
 * to date before anything boots. Using the same migration path as production
 * means the tests exercise the real DDL, including the CHECK constraints that
 * a `synchronize: true` shortcut would have skipped.
 */
export default async function globalSetup(): Promise<void> {
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

  const { AppDataSource } = await import('../../src/database/data-source');
  const ds = await AppDataSource.initialize();
  await ds.runMigrations({ transaction: 'all' });
  await ds.destroy();
}
