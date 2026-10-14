// Bundles the TypeScript API server (and DB tools) into server-dist/*.mjs with esbuild.
import * as esbuild from 'esbuild';
import { pathToFileURL } from 'node:url';

export const serverBuild = {
  entryPoints: { index: 'server/index.ts', setup: 'server/db/setup.ts', 'gen-seed': 'server/db/gen-seed.ts', selftest: 'server/db/selftest.ts' },
  outdir: 'server-dist',
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  packages: 'external',
  sourcemap: true,
  logLevel: 'warning',
};

// pathToFileURL handles Windows drive letters and folders with spaces
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await esbuild.build(serverBuild);
  console.log('server built → server-dist/');
}
