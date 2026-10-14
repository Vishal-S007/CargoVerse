// Configuration from environment variables, with an optional .env file in the project root.
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

function loadDotEnv(): void {
  const file = resolve(process.cwd(), '.env');
  if (!existsSync(file)) return;
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, ''); // inline comment: "KEY=value   # note"
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadDotEnv();

const env = (k: string, d: string) => process.env[k] ?? d;

export const config = {
  port: Number(env('PORT', '4000')),
  dbMode: env('DB_MODE', 'oracle') as 'oracle' | 'memory',
  oracle: {
    user: env('ORACLE_USER', 'waretrack'),
    password: env('ORACLE_PASSWORD', 'WareTrack_2026'),
    connectString: env('ORACLE_CONNECT_STRING', 'localhost:1521/FREEPDB1'),
  },
  memoryFile: env('MEMORY_DB_FILE', resolve(process.cwd(), '.data', 'memory-db.json')),
  sessionSecret: env('SESSION_SECRET', '') || randomBytes(32).toString('hex'),
  rememberDays: Number(env('SESSION_DAYS', '30')),
  shortSessionHours: 12,
  staticDir: env('STATIC_DIR', resolve(process.cwd(), 'dist')),
  persistEveryMs: 2000,
  streamEveryMs: 200,
};

if (!process.env.SESSION_SECRET) {
  console.warn('[config] SESSION_SECRET not set — using a random secret; sessions end when the server restarts.');
}
