// Development: rebuilds and restarts the API on change, and runs the Vite dev server.
// Usage: npm run dev            (Oracle, settings from .env)
//        npm run dev:memory     (no database server needed)
import * as esbuild from 'esbuild';
import { spawn } from 'node:child_process';
import { serverBuild } from './build-server.mjs';

const memory = process.argv.includes('--memory');
const env = { ...process.env, ...(memory ? { DB_MODE: 'memory' } : {}) };
let api = null;
let retry = null;
let stopping = false;

const restart = () => {
  clearTimeout(retry);
  if (api) { api.removeAllListeners('exit'); api.kill('SIGINT'); }
  const child = spawn(process.execPath, ['--enable-source-maps', 'server-dist/index.mjs'], { stdio: 'inherit', env });
  api = child;
  child.on('exit', (code) => {
    if (stopping || api !== child || code === 0) return;
    // the API could not start (usually: Oracle is not running yet) — say so clearly and keep trying
    const oracle = !memory && (env.DB_MODE ?? 'oracle') !== 'memory';
    console.error([
      '',
      '  ┌──────────────────────────────────────────────────────────────────────────┐',
      '  │  The CargoVerse API server is NOT running — the website cannot sign in.  │',
      ...(oracle ? [
        '  │  It could not reach Oracle (see the message above). Check that:          │',
        '  │   1. Docker Desktop is installed and open ("Engine running")             │',
        '  │   2. you ran  npm run db:up   and then  npm run db:setup                 │',
        '  │  Retrying every 10 seconds… (or stop with Ctrl+C and run                 │',
        '  │  npm run dev:memory  to try the app without Oracle)                      │',
      ] : ['  │  See the error above. Retrying every 10 seconds…                         │']),
      '  └──────────────────────────────────────────────────────────────────────────┘',
      '',
    ].join('\n'));
    retry = setTimeout(restart, 10000);
  });
};

const ctx = await esbuild.context({
  ...serverBuild,
  plugins: [{ name: 'restart', setup(b) { b.onEnd((r) => { if (!r.errors.length) restart(); }); } }],
});
await ctx.watch();

const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js'], { stdio: 'inherit', env });
const stop = () => { stopping = true; clearTimeout(retry); api?.kill('SIGINT'); vite.kill('SIGINT'); void ctx.dispose(); setTimeout(() => process.exit(0), 1500); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
