import { build } from 'esbuild';

await build({
  entryPoints: ['src/core/index.ts'],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  outfile: 'public/core.js',
  target: 'es2022',
  logLevel: 'info',
});

console.log('built public/core.js');