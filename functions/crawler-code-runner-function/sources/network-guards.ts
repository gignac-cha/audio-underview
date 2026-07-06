import { lookup } from 'node:dns/promises';

/**
 * SSRF 방어 (web type 전용 — 스펙 §5.3).
 * hostname의 **모든** resolve 주소를 검사해 하나라도 사설/내부 대역이면 거부한다.
 *
 * 알려진 한계(레거시 동일): lookup과 fetch가 별도 호출이라 DNS rebinding
 * TOCTOU 여지가 있다 — 완전 차단은 커스텀 dispatcher가 필요해 후속 과제로 남긴다.
 */

export class BlockedTargetError extends Error {
  constructor(hostname: string) {
    super(`The resolved address for '${hostname}' is not allowed`);
    this.name = 'BlockedTargetError';
  }
}

export class TargetResolutionError extends Error {
  constructor(hostname: string) {
    super(`Failed to resolve '${hostname}'`);
    this.name = 'TargetResolutionError';
  }
}

const isBlockedIPv4 = (address: string): boolean => {
  const octets = address.split('.').map(Number);
  const [first, second] = octets;
  if (first === undefined || second === undefined) {
    return true; // 파싱 불가 — 보수적으로 차단
  }
  return (
    first === 0 || // 0.0.0.0/8
    first === 127 || // loopback
    first === 10 || // RFC1918
    (first === 172 && second >= 16 && second <= 31) || // RFC1918
    (first === 192 && second === 168) || // RFC1918
    (first === 169 && second === 254) // link-local
  );
};

const isBlockedIPv6 = (address: string): boolean => {
  const normalized = address.toLowerCase();
  if (normalized === '::1' || normalized === '::') {
    return true; // loopback / unspecified
  }
  if (normalized.startsWith('fe80:')) {
    return true; // link-local
  }
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) {
    return true; // unique-local (fc00::/7)
  }
  // IPv4-mapped IPv6 (::ffff:127.0.0.1 등)
  const mappedMatch = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized);
  if (mappedMatch !== null && mappedMatch[1] !== undefined) {
    return isBlockedIPv4(mappedMatch[1]);
  }
  return false;
};

export const isBlockedAddress = (address: string, family: number): boolean =>
  family === 4 ? isBlockedIPv4(address) : isBlockedIPv6(address);

export type LookupImplementation = (
  hostname: string,
) => Promise<{ address: string; family: number }[]>;

const defaultLookup: LookupImplementation = async (hostname) =>
  lookup(hostname, { all: true, verbatim: true });

/**
 * 대상 URL 검증: http/https만 허용, 전 resolve 주소가 공인 대역이어야 통과.
 * - 프로토콜 위반 → Error (400 처리)
 * - 사설 대역 → BlockedTargetError (400 처리)
 * - DNS 실패 → TargetResolutionError (502 처리)
 */
export const validateTargetURL = async (
  url: URL,
  lookupImplementation: LookupImplementation = defaultLookup,
): Promise<void> => {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Protocol '${url.protocol}' is not allowed`);
  }

  // URL의 IPv6 literal은 대괄호로 감싸져 있다
  const hostname = url.hostname.replace(/^\[|\]$/g, '');

  let addresses: { address: string; family: number }[];
  try {
    addresses = await lookupImplementation(hostname);
  } catch {
    throw new TargetResolutionError(hostname);
  }
  if (addresses.length === 0) {
    throw new TargetResolutionError(hostname);
  }

  for (const { address, family } of addresses) {
    if (isBlockedAddress(address, family)) {
      throw new BlockedTargetError(hostname);
    }
  }
};
