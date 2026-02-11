export function createMockJWT(payload: Record<string, unknown>): string {
  const base64URLEncode = (data: string): string =>
    btoa(data).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const header = base64URLEncode(JSON.stringify({ alg: 'none', typ: 'JWT' }));
  const body = base64URLEncode(JSON.stringify(payload));
  return `${header}.${body}.fake-signature`;
}
