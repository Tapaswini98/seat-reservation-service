/**
 * Standalone migration runner. Run as a separate process on boot
 * (`node dist/migrate && node dist/main`) so a failed migration stops
 * the deploy instead of producing a half-migrated serving instance.
 */
import { AppDataSource } from './database/data-source';

async function main(): Promise<void> {
  const ds = await AppDataSource.initialize();
  try {
    const applied = await ds.runMigrations({ transaction: 'all' });
    if (applied.length === 0) {
      console.log(JSON.stringify({ msg: 'migrations: already up to date' }));
    } else {
      for (const m of applied) {
        console.log(JSON.stringify({ msg: 'migration applied', name: m.name }));
      }
    }
  } finally {
    await ds.destroy();
  }
}

main().catch((err) => {
  console.error(
    JSON.stringify({
      msg: 'migration failed',
      error: String(err?.stack ?? err),
    }),
  );
  process.exit(1);
});
