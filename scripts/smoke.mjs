// Smoke test of a production build: starts the API server, signs in and calls the main endpoints.
// Usage: npm run build && npm run smoke            (uses the in-memory database)
//        DB_MODE=oracle npm run smoke              (uses Oracle, settings from .env)
import { spawn } from 'node:child_process';

const port = Number(process.env.SMOKE_PORT ?? 4555);
const base = `http://127.0.0.1:${port}`;
const env = { ...process.env, PORT: String(port), DB_MODE: process.env.DB_MODE ?? 'memory' };
const server = spawn(process.execPath, ['--enable-source-maps', 'server-dist/index.mjs'], { env, stdio: ['ignore', 'inherit', 'inherit'] });
let failed = 0;

const stop = (code) => { server.kill(); setTimeout(() => process.exit(code), 500); };
server.on('exit', (code) => { if (code) { console.error(`server exited with code ${code}`); process.exit(1); } });

async function waitForServer() {
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(`${base}/api/health`); if (r.ok) return r.json(); } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('the server did not answer /api/health within 2 minutes');
}

async function check(name, fn) {
  try { const detail = await fn(); console.log(`  PASS  ${name}${detail ? `  (${detail})` : ''}`); }
  catch (e) { failed++; console.log(`  FAIL  ${name}: ${e.message}`); }
}

async function get(path, token) {
  const r = await fetch(base + path, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  if (!r.ok) throw new Error(`${path} → HTTP ${r.status}`);
  return r;
}

try {
  const health = await waitForServer();
  console.log(`\nSmoke test against ${base} (database: ${health.db})\n`);
  await check('website is served', async () => {
    const html = await (await get('/')).text();
    if (!html.includes('<div id="root">')) throw new Error('index.html not served (run npm run build first)');
  });
  let token = null;
  await check('sign in as admin', async () => {
    const r = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'Admin@123' }) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    token = (await r.json()).token;
    if (!token) throw new Error('no token returned');
  });
  await check('wrong password is refused', async () => {
    const r = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'wrong' }) });
    if (r.status !== 401) throw new Error(`expected 401, got ${r.status}`);
  });
  for (const [name, path] of [
    ['warehouse overview', '/api/wms/overview'],
    ['bins of WH-04', '/api/wms/bins/WH-04'],
    ['ABC slotting report', '/api/wms/abc/WH-02'],
    ['lots and FEFO', '/api/wms/lots'],
    ['cold chain', '/api/wms/cold'],
    ['ledger verification', '/api/wms/ledger'],
    ['replenishment', '/api/wms/replenishment'],
    ['semantic search', '/api/wms/search?q=broken%20glass'],
  ]) {
    await check(name, async () => { const j = await (await get(path, token)).json(); return j.source ? `source: ${j.source}` : ''; });
  }
  console.log(failed ? `\n${failed} smoke check(s) failed\n` : '\nAll smoke checks passed\n');
  stop(failed ? 1 : 0);
} catch (e) {
  console.error(`\nSmoke test failed: ${e.message}\n`);
  stop(1);
}
