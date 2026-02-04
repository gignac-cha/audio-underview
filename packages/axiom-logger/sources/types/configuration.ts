/**
 * Axiom logger configuration for Workers
 */
export interface AxiomLoggerConfiguration {
  /**
   * Axiom API token with ingest permissions
   */
  token: string;

  /**
   * Axiom dataset name to send traces to
   */
  dataset: string;

  /**
   * Service name for identification in traces
   */
  serviceName: string;

  /**
   * Axiom API URL (defaults to https://api.axiom.co)
   */
  axiomURL?: string;
}

/**
 * Configuration resolver function type
 * Receives environment and returns configuration
 */
export type ConfigurationResolver<E> = (environment: E) => AxiomLoggerConfiguration;
