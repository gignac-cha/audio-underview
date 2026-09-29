import { describe, test, expect } from 'vitest';
import { generateState } from '@audio-underview/sign-provider';
import {
  isAllowedRedirectURI,
  isValidOAuthState,
  parseAllowedOrigins,
} from './oauth-request-policy.ts';
import * as oauthRequestPolicy from './oauth-request-policy.ts';

const ALLOWED_ORIGINS = 'http://localhost:5173,https://audio-underview.pages.dev';
const FRONTEND_URL = 'https://audio-underview.pages.dev';

const origins = parseAllowedOrigins(ALLOWED_ORIGINS, FRONTEND_URL);

describe('isValidOAuthState', () => {
  test('accepts exactly what generateState produces', () => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      expect(isValidOAuthState(generateState())).toBe(true);
    }
  });

  test('refuses the other keys this KV namespace holds', () => {
    // The state is used verbatim as a KV key by the shared verifyState, which
    // deletes what it reads — these must never be nameable as a state.
    expect(isValidOAuthState('account/github/38489680')).toBe(false);
    expect(isValidOAuthState('account/google/google-sub-1')).toBe(false);
    expect(isValidOAuthState('link-ticket/6f1d4c9e-0f1a-4c5e-9a1b-2c3d4e5f6071')).toBe(false);
  });

  test('refuses anything that is not 32 alphanumeric characters', () => {
    expect(isValidOAuthState(null)).toBe(false);
    expect(isValidOAuthState(undefined)).toBe(false);
    expect(isValidOAuthState('')).toBe(false);
    expect(isValidOAuthState('short')).toBe(false);
    expect(isValidOAuthState('a'.repeat(31))).toBe(false);
    expect(isValidOAuthState('a'.repeat(33))).toBe(false);
    expect(isValidOAuthState(`${'a'.repeat(31)}/`)).toBe(false);
    expect(isValidOAuthState(`${'a'.repeat(31)}\n`)).toBe(false);
  });
});

describe('parseAllowedOrigins', () => {
  test('normalizes every configured entry to a bare origin', () => {
    expect([...origins].sort()).toEqual([
      'http://localhost:5173',
      'https://audio-underview.pages.dev',
    ]);
  });

  test('tolerates whitespace, empty entries and unset configuration', () => {
    expect([...parseAllowedOrigins(' https://a.example.com , ,https://b.example.com ')]).toEqual([
      'https://a.example.com',
      'https://b.example.com',
    ]);
    expect(parseAllowedOrigins(undefined).size).toBe(0);
    expect(parseAllowedOrigins('').size).toBe(0);
    expect(parseAllowedOrigins('not a url', 'also-not-a-url').size).toBe(0);
  });
});

describe('isAllowedRedirectURI', () => {
  test('accepts any path on an allowed origin', () => {
    expect(isAllowedRedirectURI('https://audio-underview.pages.dev/authentication/callback', origins)).toBe(true);
    expect(isAllowedRedirectURI('http://localhost:5173/settings', origins)).toBe(true);
  });

  test('refuses an origin nobody listed', () => {
    // The callback appends user, access_token, uuid and a 24-hour session JWT.
    expect(isAllowedRedirectURI('https://evil.example.net/steal', origins)).toBe(false);
  });

  test('refuses look-alike origins', () => {
    expect(isAllowedRedirectURI('https://audio-underview.pages.dev.evil.net/', origins)).toBe(false);
    expect(isAllowedRedirectURI('http://audio-underview.pages.dev/', origins)).toBe(false);
    expect(isAllowedRedirectURI('https://audio-underview.pages.dev:8443/', origins)).toBe(false);
  });

  test('refuses non http(s) and unparseable targets', () => {
    expect(isAllowedRedirectURI('javascript:alert(1)', origins)).toBe(false);
    expect(isAllowedRedirectURI('data:text/html,<script></script>', origins)).toBe(false);
    expect(isAllowedRedirectURI('/settings', origins)).toBe(false);
    expect(isAllowedRedirectURI('', origins)).toBe(false);
    expect(isAllowedRedirectURI(null, origins)).toBe(false);
  });
});

describe('link initiator policy', () => {
  test('offers no Referer-based link guard any more', () => {
    // Deliberate replacement, not a weakened assertion: `/authorize` is a
    // cookie-less GET, so an attacker calls it server side with any Referer
    // they like and the check protected nobody while breaking
    // Referer-stripping browsers. The binding it pretended to provide now
    // lives in `POST /accounts/link-confirm` (nonce + link code + session JWT),
    // and this test pins that the ineffective one does not creep back.
    expect('isTrustedLinkInitiator' in oauthRequestPolicy).toBe(false);
  });
});
