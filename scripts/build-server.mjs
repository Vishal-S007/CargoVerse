// Bundles the TypeScript API server (and DB tools) into server-dist/*.mjs with esbuild.
import * as esbuild from 'esbuild';

export const serverBuild = {
  entryPoints: { index: 'server/index.ts', setup: 'server/db/setup.ts', 'gen-seed': 'server/db/gen-seed.ts' },
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

if (import.meta.url === `file://${process.argv[1]}`) {
  await esbuild.build(serverBuild);
  console.log('server built → server-dist/');
}
