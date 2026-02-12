import * as esbuild from 'esbuild';

await esbuild.build({
  entryPoints: ['sources/index.ts'],
  bundle: true,
  outfile: 'outputs/index.mjs',
  platform: 'node',
  target: 'node22',
  format: 'esm',
  minify: true,
  sourcemap: true,
});

console.info('Build completed: outputs/index.mjs');
