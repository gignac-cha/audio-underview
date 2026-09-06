import { describe, expect, it, vi } from 'vitest';
import { Logger } from '../sources/logger.ts';
import { createAxiomTransport } from '../sources/transports/axiom-transport.ts';
import type { LogRecord, LogTransport } from '../sources/types.ts';

const createCapturingTransport = (): { transport: LogTransport; records: LogRecord[] } => {
  const records: LogRecord[] = [];
  return { transport: { write: (record) => records.push(record) }, records };
};

describe('Logger', () => {
  it('respects the minimum level', () => {
    const { transport, records } = createCapturingTransport();
    const logger = new Logger({ minimumLevel: 'warn', transports: [transport] });

    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');

    expect(records.map((record) => record.level)).toEqual(['warn', 'error']);
  });

  it('merges child contexts (metadata 포함)', () => {
    const { transport, records } = createCapturingTransport();
    const logger = new Logger({
      transports: [transport],
      defaultContext: { module: 'worker', metadata: { region: 'apac' } },
    });

    logger.createChild({ function: 'handle', metadata: { requestID: 'r1' } }).info('m');

    expect(records[0]?.context).toEqual({
      module: 'worker',
      function: 'handle',
      metadata: { region: 'apac', requestID: 'r1' },
    });
  });

  it('serializes errors', () => {
    const { transport, records } = createCapturingTransport();
    const logger = new Logger({ transports: [transport] });

    logger.error('failed', new TypeError('boom'));

    expect(records[0]?.error).toMatchObject({ name: 'TypeError', message: 'boom' });
  });

  it('does not write when disabled', () => {
    const { transport, records } = createCapturingTransport();
    const logger = new Logger({ transports: [transport], enabled: false });

    logger.error('e');

    expect(records).toHaveLength(0);
  });

  it('survives a throwing transport', () => {
    const throwing: LogTransport = {
      write: () => {
        throw new Error('transport down');
      },
    };
    const { transport, records } = createCapturingTransport();
    const logger = new Logger({ transports: [throwing, transport] });

    expect(() => { logger.info('m'); }).not.toThrow();
    expect(records).toHaveLength(1);
  });
});

describe('createAxiomTransport', () => {
  it('batches records and sends them on flush', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const transport = createAxiomTransport({
      token: 'token',
      dataset: 'main',
      serviceName: 'test-service',
      fetchImplementation: fetchMock,
    });
    const logger = new Logger({ transports: [transport] });

    logger.info('one');
    logger.info('two');
    expect(fetchMock).not.toHaveBeenCalled();

    await logger.flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, request] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.axiom.co/v1/datasets/main/ingest');
    const events = JSON.parse(request.body as string) as { message: string; service: string }[];
    expect(events.map((event) => event.message)).toEqual(['one', 'two']);
    expect(events[0]?.service).toBe('test-service');
  });

  it('auto-drains when the buffer limit is reached', () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const transport = createAxiomTransport({
      token: 'token',
      dataset: 'main',
      maximumBufferSize: 2,
      fetchImplementation: fetchMock,
    });
    const logger = new Logger({ transports: [transport] });

    logger.info('one');
    logger.info('two');

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('swallows ingest failures', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));
    const transport = createAxiomTransport({
      token: 'token',
      dataset: 'main',
      fetchImplementation: fetchMock,
    });
    const logger = new Logger({ transports: [transport] });

    logger.info('one');
    await expect(logger.flush()).resolves.toBeUndefined();
  });
});
