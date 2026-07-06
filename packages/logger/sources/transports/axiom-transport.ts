import type { LogRecord, LogTransport } from '../types.ts';

export interface AxiomTransportOptions {
  token: string;
  dataset: string;
  serviceName?: string;
  /** 기본: https://api.axiom.co */
  axiomURL?: string;
  /** 버퍼가 이 개수에 도달하면 자동 플러시 (기본 32) */
  maximumBufferSize?: number;
  /** 테스트 주입용 — 기본 globalThis.fetch */
  fetchImplementation?: typeof fetch;
}

const DEFAULT_AXIOM_URL = 'https://api.axiom.co';
const DEFAULT_MAXIMUM_BUFFER_SIZE = 32;

/**
 * Axiom ingest API로 로그를 배치 전송하는 transport.
 *
 * 레거시 axiom-logger는 OpenTelemetry(@microlabs/otel-cf-workers) 기반이었으나,
 * 재작성에서는 의존성 없이 ingest HTTP API를 직접 사용한다 (ADR: 경량화).
 * worker에서는 응답 후 `executionContext.waitUntil(logger.flush())`로 배출한다.
 */
export const createAxiomTransport = (options: AxiomTransportOptions): LogTransport => {
  const axiomURL = options.axiomURL ?? DEFAULT_AXIOM_URL;
  const maximumBufferSize = options.maximumBufferSize ?? DEFAULT_MAXIMUM_BUFFER_SIZE;
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const ingestURL = `${axiomURL}/v1/datasets/${options.dataset}/ingest`;

  let buffer: Record<string, unknown>[] = [];
  let inflight: Promise<void> | undefined;

  const send = async (events: Record<string, unknown>[]): Promise<void> => {
    try {
      await fetchImplementation(ingestURL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${options.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(events),
      });
    } catch {
      // 로그 전송 실패는 무시한다 — 애플리케이션 흐름에 영향 금지
    }
  };

  const drain = (): void => {
    if (buffer.length === 0) {
      return;
    }
    const events = buffer;
    buffer = [];
    const sending = send(events);
    inflight = (inflight ?? Promise.resolve()).then(() => sending);
  };

  return {
    write(record: LogRecord): void {
      buffer.push({
        _time: record.timestamp,
        level: record.level,
        message: record.message,
        service: options.serviceName,
        ...record.context,
        data: record.data,
        error: record.error,
      });
      if (buffer.length >= maximumBufferSize) {
        drain();
      }
    },

    async flush(): Promise<void> {
      drain();
      await inflight;
      inflight = undefined;
    },
  };
};
