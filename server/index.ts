// CargoVerse API server: `npm run server` (Oracle) or `DB_MODE=memory npm run server`.
import { createServer } from 'node:http';
import { config } from './config';
import type { Repo } from './db/repo';
import { MemoryRepo } from './db/memory';
import { OracleRepo } from './db/oracle';
import { SimHost } from './simhost';
import { buildRouter } from './routes';

async function main(): Promise<void> {
  const repo: Repo = config.dbMode === 'memory' ? new MemoryRepo(config.memoryFile) : new OracleRepo(config.oracle);
  try {
    await repo.init();
  } catch (e) {
    console.error(`\n[cargoverse] Could not start with DB_MODE=${config.dbMode}:\n  ${(e as Error).message}\n`);
    if (config.dbMode === 'oracle') {
      console.error('  Check that Oracle is running (npm run db:up), the schema is installed (npm run db:setup),');
      console.error(`  and ORACLE_CONNECT_STRING=${config.oracle.connectString} / ORACLE_USER=${config.oracle.user} in .env are correct.\n`);
    }
    process.exit(1);
  }

  const host = new SimHost(repo, config.persistEveryMs);
  await host.start();
  const router = buildRouter(repo, host, {
    secret: config.sessionSecret, rememberDays: config.rememberDays, shortHours: config.shortSessionHours, streamEveryMs: config.streamEveryMs,
  });

  const server = createServer((req, res) => { void router.handle(req, res, config.staticDir); });
  server.listen(config.port, () => {
    console.log(`[cargoverse] API on http://localhost:${config.port}  ·  database: ${repo.kind}${repo.kind === 'oracle' ? ` (${config.oracle.connectString})` : ` (${config.memoryFile})`}`);
  });

  const shutdown = async () => {
    console.log('\n[cargoverse] saving state and shutting down…');
    server.close();
    await host.stop();
    await repo.close();
    process.exit(0);
  };
  process.on('SIGINT', () => { void shutdown(); });
  process.on('SIGTERM', () => { void shutdown(); });
}

void main();
