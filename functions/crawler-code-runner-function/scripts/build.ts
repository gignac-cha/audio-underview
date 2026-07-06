import { build } from 'esbuild';

/** Lambda 배포 번들 — `outputs/index.mjs` (nodejs22.x 런타임, ESM) */
await build({
  entryPoints: ['sources/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  outfile: 'outputs/index.mjs',
  minify: true,
  sourcemap: false,
  banner: {
    // ESM 번들에서 CommonJS 의존성이 require를 찾을 수 있도록
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
});
