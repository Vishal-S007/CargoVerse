// npm run db:up — starts Oracle Database Free in Docker, with a clear message if Docker is missing.
import { spawnSync } from 'node:child_process';

const has = spawnSync('docker', ['--version'], { stdio: 'ignore' });
if (has.error || has.status !== 0) {
  console.error(`
Docker is not installed (or not on the PATH), so Oracle cannot be started.

  1. Install Docker Desktop: https://www.docker.com/products/docker-desktop/
     (on an Apple-silicon Mac choose "Download for Mac – Apple Silicon")
  2. Open Docker Desktop once and wait until it says "Engine running".
  3. Run again:  npm run db:up   then   npm run db:setup   then   npm run dev

Without Oracle you can still try the app with:  npm run dev:memory
`);
  process.exit(1);
}
const info = spawnSync('docker', ['info'], { stdio: 'ignore' });
if (info.status !== 0) {
  console.error('\nDocker is installed but not running. Open Docker Desktop, wait for "Engine running", then run npm run db:up again.\n');
  process.exit(1);
}
const r = spawnSync('docker', ['compose', 'up', '-d', 'oracle'], { stdio: 'inherit' });
if (r.status === 0) console.log('\nOracle is starting (first time: it downloads ~1 GB, then needs 1–2 minutes). Next: npm run db:setup\n');
process.exit(r.status ?? 1);
