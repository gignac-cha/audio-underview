import type { Logger } from '@audio-underview/logger';

export interface LambdaEvent {
  version?: string;
  requestContext: {
    http: {
      method: string;
      path: string;
      protocol?: string;
      sourceIP?: string;
      userAgent?: string;
    };
    accountID?: string;
    requestID?: string;
    domainName?: string;
    domainPrefix?: string;
    time?: string;
    timeEpoch?: number;
  };
  headers: Record<string, string>;
  queryStringParameters?: Record<string, string>;
  body?: string;
  isBase64Encoded?: boolean;
}

export interface LambdaResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

export interface ResponseContext {
  origin: string;
  allowedOrigins: string;
  logger: Logger;
}

export interface ErrorResponseBody {
  error: string;
  error_description?: string;
}
