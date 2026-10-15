// The main module of the worker under test, as `wrangler types` declares it, so the `exports` of
// cloudflare:workers have the types of its entrypoints
declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import('../sources/index.ts');
  }
}
