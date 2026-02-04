import { instrument, type ResolveConfigFn } from '@microlabs/otel-cf-workers';
import type { AxiomLoggerConfiguration, ConfigurationResolver } from './types/index.ts';

const DEFAULT_AXIOM_URL = 'https://api.axiom.co';

/**
 * Wraps a Cloudflare Worker handler with OpenTelemetry instrumentation
 * that exports traces to Axiom.
 *
 * @param handler - The worker handler to instrument
 * @param configResolver - Function that receives environment and returns Axiom configuration
 * @returns Instrumented worker handler
 *
 * @example
 * ```typescript
 * const handler = {
 *   async fetch(request: Request, environment: Environment): Promise<Response> {
 *     // ... worker logic
 *   }
 * };
 *
 * export default instrumentWorker(handler, (environment) => ({
 *   token: environment.AXIOM_TOKEN,
 *   dataset: environment.AXIOM_DATASET,
 *   serviceName: 'my-worker',
 * }));
 * ```
 */
export function instrumentWorker<E>(
  handler: ExportedHandler<E>,
  configResolver: ConfigurationResolver<E>
): ExportedHandler<E> {
  const resolveConfig: ResolveConfigFn<E> = (environment, _trigger) => {
    const config = configResolver(environment);
    const axiomURL = config.axiomURL ?? DEFAULT_AXIOM_URL;

    return {
      exporter: {
        url: `${axiomURL}/v1/traces`,
        headers: {
          Authorization: `Bearer ${config.token}`,
          'X-Axiom-Dataset': config.dataset,
        },
      },
      service: {
        name: config.serviceName,
      },
    };
  };

  // Type assertion needed due to @microlabs/otel-cf-workers generic constraints
  return instrument(
    handler as ExportedHandler,
    resolveConfig as ResolveConfigFn
  ) as ExportedHandler<E>;
}
