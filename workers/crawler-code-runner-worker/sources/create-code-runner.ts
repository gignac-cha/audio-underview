export interface CodeRunner {
  execute(data: string): Promise<unknown>;
}

export function createCodeRunner(
  loader: WorkerLoader,
  code: string,
): CodeRunner {
  const worker = loader.get(`run-${Date.now()}`, () => ({
    compatibilityDate: '2025-11-25',
    mainModule: 'runner.js',
    modules: {
      'runner.js': `
        import { WorkerEntrypoint } from 'cloudflare:workers';

        export class Runner extends WorkerEntrypoint {
          async execute(data) {
            const fn = (${code});
            return await fn(data);
          }
        }
      `,
    },
    globalOutbound: null,
  }));

  return worker.getEntrypoint('Runner') as CodeRunner;
}
