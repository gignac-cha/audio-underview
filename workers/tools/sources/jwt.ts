export interface JWTPayload {
  sub: string;
  iat: number;
  exp: number;
  [key: string]: unknown;
}

function base64URLEncode(data: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < data.length; i++) {
    binary += String.fromCharCode(data[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64URLEncodeString(data: string): string {
  return btoa(data).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64URLDecode(input: string): Uint8Array {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/');
  const paddedWithEquals = padded + '='.repeat((4 - (padded.length % 4)) % 4);
  const binary = atob(paddedWithEquals);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function importKey(secret: string): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

export async function signJWT(payload: JWTPayload, secret: string): Promise<string> {
  const header = base64URLEncodeString(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = base64URLEncodeString(JSON.stringify(payload));
  const signingInput = `${header}.${body}`;

  const key = await importKey(secret);
  const encoder = new TextEncoder();
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(signingInput));

  return `${signingInput}.${base64URLEncode(new Uint8Array(signature))}`;
}

export async function verifyJWT(token: string, secret: string): Promise<JWTPayload | null> {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) {
      return null;
    }

    const [header, body, signature] = parts;
    const signingInput = `${header}.${body}`;

    const key = await importKey(secret);
    const encoder = new TextEncoder();
    const signatureBytes = base64URLDecode(signature);

    const valid = await crypto.subtle.verify('HMAC', key, signatureBytes, encoder.encode(signingInput));
    if (!valid) {
      return null;
    }

    const decodedBody = new TextDecoder().decode(base64URLDecode(body));
    const payload = JSON.parse(decodedBody) as JWTPayload;

    if (typeof payload.exp === 'number' && payload.exp < Math.floor(Date.now() / 1000)) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}
