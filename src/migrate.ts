/**
 * Standalone migration runner.
 *
 * Runs as a separate process on boot (`node dist/migrate && node dist/main`)
 * so a failed migration stops the deploy instead of producing an instance
 * that serves traffic against a half-migrated database.
 */
import { AppDataSource } from './models/data-source';

async function main(): Promise<void> {
  const dataSource = await AppDataSource.initialize();
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
    JSON.stringify({ msg: 'migration failed', error: String(err?.stack ?? err) }),
  );
  process.exit(1);
});
