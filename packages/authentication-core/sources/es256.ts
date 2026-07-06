/**
 * ES256 JWT 서명 — apple client secret 생성 전용 (스펙 §6 apple).
 * PKCS8 PEM(P-256) 개인키를 WebCrypto로 import해 서명한다.
 */

const base64URLEncode = (bytes: Uint8Array): string => {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
};

const importPKCS8PrivateKey = async (pem: string): Promise<CryptoKey> => {
  const base64 = pem
    .replace('-----BEGIN PRIVATE KEY-----', '')
    .replace('-----END PRIVATE KEY-----', '')
    .replaceAll(/\s/g, '');
  const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
  return crypto.subtle.importKey('pkcs8', bytes, { name: 'ECDSA', namedCurve: 'P-256' }, false, [
    'sign',
  ]);
};

export interface SignES256JWTOptions {
  keyID: string;
  privateKeyPEM: string;
  payload: Record<string, unknown>;
}

export const signES256JWT = async (options: SignES256JWTOptions): Promise<string> => {
  const encoder = new TextEncoder();
  const headerPart = base64URLEncode(
    encoder.encode(JSON.stringify({ alg: 'ES256', kid: options.keyID, typ: 'JWT' })),
  );
  const payloadPart = base64URLEncode(encoder.encode(JSON.stringify(options.payload)));

  const key = await importPKCS8PrivateKey(options.privateKeyPEM);
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    encoder.encode(`${headerPart}.${payloadPart}`),
  );

  return `${headerPart}.${payloadPart}.${base64URLEncode(new Uint8Array(signature))}`;
};
