/**
 * Standalone migration runner.
 *
 * Runs as a separate process on boot (`node dist/migrate && node dist/main`)
 * so a failed migration stops the deploy instead of producing an instance
 * that serves traffic against a half-migrated database.
 */
import { config as loadEnv } from 'dotenv';
loadEnv();

import type { DataSource } from 'typeorm';

/**
 * A freshly provisioned managed database is often still coming up when the
 * first container starts, so a single connect attempt turns a 20-second race
 * into a failed deploy. Bounded, and it retries only the *connection* -- a
 * migration that runs and fails still aborts immediately.
 */
const CONNECT_MAX_WAIT_MS = 60_000;
const CONNECT_RETRY_MS = 3_000;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const connectWithRetry = async (dataSource: DataSource): Promise<DataSource> => {
  const deadline = Date.now() + CONNECT_MAX_WAIT_MS;
  let attempt = 0;

  for (;;) {
    attempt += 1;
    try {
      return await dataSource.initialize();
    } catch (err) {
      if (Date.now() >= deadline) throw err;
      console.log(
        JSON.stringify({
          msg: 'database not reachable yet, retrying',
          attempt,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
      await sleep(CONNECT_RETRY_MS);
    }
  }
};

async function main(): Promise<void> {
  // Imported dynamically, and only after config has been read, so a
  // misconfigured environment fails with the explanatory message from
  // `resolveDatabaseUrl` instead of an unhandled module-load stack trace.
  const { describeDatabaseTarget, loadConfig } = await import('./config/configuration');
  const config = loadConfig();

  // Host and port only -- enough to tell "wrong database" from "database
  // down" in a deploy log, without putting the password in it.
  console.log(
    JSON.stringify({
      msg: 'running migrations',
      target: describeDatabaseTarget(config.database.url),
      ssl: config.database.ssl,
    }),
  );

  const { AppDataSource } = await import('./models/data-source');
  const dataSource = await connectWithRetry(AppDataSource);

  try {
    const applied = await dataSource.runMigrations({ transaction: 'all' });
    if (applied.length === 0) {
      console.log(JSON.stringify({ msg: 'migrations: already up to date' }));
      return;
    }
    for (const migration of applied) {
      console.log(JSON.stringify({ msg: 'migration applied', name: migration.name }));
    }
  } finally {
    await dataSource.destroy();
  }
}

main().catch((err) => {
  console.error(
    JSON.stringify({
      msg: 'migration failed',
      error: err instanceof Error ? err.message : String(err),
    }),
  );
  process.exit(1);
});
