/**
 * Database operation types
 */
export type DatabaseOperation = 'select' | 'insert' | 'update' | 'delete';

/**
 * Options for tracing database operations
 */
export interface TraceDatabaseOperationOptions {
  /**
   * Service name for identifying the source of the log
   */
  serviceName: string;

  /**
   * Type of database operation
   */
  operation: DatabaseOperation;

  /**
   * Table name being operated on
   */
  table: string;

  /**
   * Optional SQL statement (be careful with sensitive data)
   */
  statement?: string;
}
