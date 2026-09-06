import { JWT_AUDIENCE, JWT_ISSUER } from '@audio-underview/schemas';
import { createWorkerRouter, type WorkerRouter } from '@audio-underview/worker-foundation';
import type { WorkerEnvironment } from './environment.ts';
import {
  handleCreateCrawler,
  handleDeleteCrawler,
  handleGetCrawler,
  handleListCrawlers,
  handleUpdateCrawler,
} from './handlers/crawlers.ts';
import type { ResolveServices } from './services.ts';

export const SERVICE_NAME = 'audio-underview-crawler-manager-worker';

export const createCrawlerManagerRouter = (
  resolveServices: ResolveServices,
): WorkerRouter<WorkerEnvironment> =>
  createWorkerRouter<WorkerEnvironment>({
    serviceName: SERVICE_NAME,
    help: [
      { method: 'GET', path: '/', description: 'Service help' },
      { method: 'POST', path: '/crawlers', description: 'Create a crawler' },
      { method: 'GET', path: '/crawlers', description: 'List crawlers (offset/limit)' },
      { method: 'GET', path: '/crawlers/:crawlerID', description: 'Get a crawler' },
      { method: 'PUT', path: '/crawlers/:crawlerID', description: 'Replace a crawler' },
      { method: 'DELETE', path: '/crawlers/:crawlerID', description: 'Delete a crawler' },
    ],
    cors: {
      allowMethods: 'GET, POST, PUT, DELETE, OPTIONS',
      allowHeaders: 'Content-Type, Authorization',
    },
    resolveAllowedOrigins: (environment) => environment.ALLOWED_ORIGINS,
    resolveAuthentication: (environment) =>
      environment.JWT_SECRET === undefined
        ? undefined
        : { secret: environment.JWT_SECRET, issuer: JWT_ISSUER, audience: JWT_AUDIENCE },
    routes: [
      {
        method: 'POST',
        pattern: '/crawlers',
        requiresAuthentication: true,
        handler: (context) => handleCreateCrawler(context, resolveServices(context.environment)),
      },
      {
        method: 'GET',
        pattern: '/crawlers',
        requiresAuthentication: true,
        handler: (context) => handleListCrawlers(context, resolveServices(context.environment)),
      },
      {
        method: 'GET',
        pattern: '/crawlers/:crawlerID',
        requiresAuthentication: true,
        handler: (context) => handleGetCrawler(context, resolveServices(context.environment)),
      },
      {
        method: 'PUT',
        pattern: '/crawlers/:crawlerID',
        requiresAuthentication: true,
        handler: (context) => handleUpdateCrawler(context, resolveServices(context.environment)),
      },
      {
        method: 'DELETE',
        pattern: '/crawlers/:crawlerID',
        requiresAuthentication: true,
        handler: (context) => handleDeleteCrawler(context, resolveServices(context.environment)),
      },
    ],
  });
