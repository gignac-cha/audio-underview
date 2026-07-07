/**
 * OAuth 플로우용 난수 생성 (Web Crypto).
 * 레거시 `generateState`의 modulo bias(byte % 62)를 rejection sampling으로 제거 (스펙 §10.5).
 */

const STATE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
/** PKCE unreserved characters (RFC 7636) */
const CODE_VERIFIER_ALPHABET = `${STATE_ALPHABET}-._~`;

const generateRandomString = (length: number, alphabet: string): string => {
  // rejection sampling — alphabet 크기의 최대 배수 미만 값만 사용해 균등 분포 보장
  const limit = Math.floor(256 / alphabet.length) * alphabet.length;
  const characters: string[] = [];
  const buffer = new Uint8Array(length * 2);

  while (characters.length < length) {
    crypto.getRandomValues(buffer);
    for (const byte of buffer) {
      if (byte < limit) {
        // rejection sampling으로 인덱스가 항상 유효하므로 charAt은 빈 문자열을 반환하지 않는다
        characters.push(alphabet.charAt(byte % alphabet.length));
        if (characters.length === length) {
          break;
        }
      }
    }
  }
  return characters.join('');
};

export const generateState = (length = 32): string =>
  generateRandomString(length, STATE_ALPHABET);

export const generateNonce = (length = 32): string =>
  generateRandomString(length, STATE_ALPHABET);

export const generateCodeVerifier = (length = 64): string =>
  generateRandomString(length, CODE_VERIFIER_ALPHABET);

export const generateAuthorizationCode = (length = 48): string =>
  generateRandomString(length, STATE_ALPHABET);

export const generateRefreshToken = (length = 64): string =>
  generateRandomString(length, STATE_ALPHABET);

const base64URLEncode = (bytes: Uint8Array): string => {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
};

/** PKCE S256 code challenge */
export const generateCodeChallenge = async (codeVerifier: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier));
  return base64URLEncode(new Uint8Array(digest));
};
