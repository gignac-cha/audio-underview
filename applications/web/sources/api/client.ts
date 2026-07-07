import { tokenResponseSchema } from '@audio-underview/schemas';
import type { z } from 'zod';
import { requireServiceURL, type ServiceURLKey } from '../environment.ts';
import { sessionAtom, type StoredSession } from '../state/session.ts';
import type { ApplicationStore } from '../state/store.ts';
import { ApiError, AuthenticationRequiredError, deriveErrorFromResponse } from './errors.ts';

/** access token 만료 판단 시 시계 오차 여유 (밀리초). */
const EXPIRY_SKEW_MILLISECONDS = 30_000;
const DEFAULT_TIMEOUT_MILLISECONDS = 30_000;

export interface RequestOptions<Parsed> {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | undefined>;
  signal?: AbortSignal;
  /** true(기본)면 Authorization 헤더 주입 + 401 시 refresh 재시도. */
  authenticated?: boolean;
  timeoutMilliseconds?: number;
  /** 응답 검증 스키마. 없으면 undefined 반환 (204/DELETE 등). */
  schema?: z.ZodType<Parsed>;
}

/**
 * 단일 authenticated fetch 클라이언트.
 * - Bearer 주입 + 자동 refresh 인터셉터(만료/401 시 `POST {AUTH}/tokens` refresh_token grant)
 * - 실패 시 로그아웃(세션 폐기)
 * - `{ error, error_description }` 파싱 (errors.ts)
 * 세션 단일 소스는 jotai `sessionAtom` — 클라이언트가 직접 읽고/쓴다.
 */
export class ApiClient {
  private readonly store: ApplicationStore;
  private readonly onLogout: () => void;
  private refreshInFlight: Promise<StoredSession> | null = null;

  constructor(store: ApplicationStore, onLogout: () => void) {
    this.store = store;
    this.onLogout = onLogout;
  }

  private getSession(): StoredSession | null {
    return this.store.get(sessionAtom);
  }

  private buildURL(baseURL: string, path: string, query?: RequestOptions<unknown>['query']): string {
    const url = new URL(`${baseURL}${path}`);
    if (query !== undefined) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) {
          url.searchParams.set(key, String(value));
        }
      }
    }
    return url.toString();
  }

  private buildSignal(timeoutMilliseconds: number, signal?: AbortSignal): AbortSignal {
    const timeoutSignal = AbortSignal.timeout(timeoutMilliseconds);
    return signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal]);
  }

  /** 유효한 access token 확보 — 만료 임박 시 선제적으로 refresh. */
  private async ensureAccessToken(): Promise<string> {
    const session = this.getSession();
    if (session === null) {
      throw new AuthenticationRequiredError();
    }
    if (session.expiresAt - EXPIRY_SKEW_MILLISECONDS <= Date.now()) {
      const refreshed = await this.refreshSession(session);
      return refreshed.accessToken;
    }
    return session.accessToken;
  }

  /** refresh_token grant. 동시 호출은 단일 요청으로 합류시킨다. */
  private async refreshSession(session: StoredSession): Promise<StoredSession> {
    this.refreshInFlight ??= this.performRefresh(session).finally(() => {
      this.refreshInFlight = null;
    });
    return this.refreshInFlight;
  }

  private async performRefresh(session: StoredSession): Promise<StoredSession> {
    const baseURL = requireServiceURL('VITE_AUTHENTICATION_WORKER_URL');
    let response: Response;
    try {
      response = await fetch(`${baseURL}/tokens`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          refresh_token: session.refreshToken,
        }),
        signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MILLISECONDS),
      });
    } catch {
      this.onLogout();
      throw new ApiError('Your session could not be refreshed. Please sign in again.', 401);
    }
    if (!response.ok) {
      this.onLogout();
      throw await deriveErrorFromResponse(response);
    }
    const raw: unknown = await response.json();
    const parsed = tokenResponseSchema.safeParse(raw);
    if (!parsed.success) {
      this.onLogout();
      throw new ApiError('Received an invalid session token. Please sign in again.', 401);
    }
    const next: StoredSession = {
      accessToken: parsed.data.access_token,
      refreshToken: parsed.data.refresh_token,
      expiresAt: Date.now() + parsed.data.expires_in * 1000,
      user: parsed.data.user,
    };
    this.store.set(sessionAtom, next);
    return next;
  }

  async request<Parsed = undefined>(
    serviceKey: ServiceURLKey,
    path: string,
    options: RequestOptions<Parsed> = {},
  ): Promise<Parsed> {
    const {
      method = 'GET',
      body,
      query,
      signal,
      authenticated = true,
      timeoutMilliseconds = DEFAULT_TIMEOUT_MILLISECONDS,
      schema,
    } = options;

    const baseURL = requireServiceURL(serviceKey);
    const url = this.buildURL(baseURL, path, query);

    const send = async (accessToken: string | null): Promise<Response> => {
      const headers: Record<string, string> = {};
      if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
      }
      if (accessToken !== null) {
        headers.Authorization = `Bearer ${accessToken}`;
      }
      return fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: this.buildSignal(timeoutMilliseconds, signal),
      });
    };

    let response: Response;
    if (authenticated) {
      const accessToken = await this.ensureAccessToken();
      response = await send(accessToken);
      // access token이 유효 판단이었음에도 서버가 401 → 강제 refresh 후 1회 재시도
      if (response.status === 401) {
        const session = this.getSession();
        if (session !== null) {
          const refreshed = await this.refreshSession(session);
          response = await send(refreshed.accessToken);
        }
      }
    } else {
      response = await send(null);
    }

    if (!response.ok) {
      throw await deriveErrorFromResponse(response);
    }

    if (schema === undefined) {
      return undefined as Parsed;
    }
    const raw: unknown = await response.json();
    return schema.parse(raw);
  }
}
