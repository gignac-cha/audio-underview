/**
 * Which addresses the code of a crawler may not reach. Addresses are compared as bytes against
 * CIDR ranges, so every textual form of an address (URL-normalized IPv6, IPv4 inside IPv6) is caught.
 */

interface AddressRange {
  bytes: number[];
  prefixLength: number;
}

function range(text: string, prefixLength: number): AddressRange {
  const bytes = text.includes(':') ? parseIPv6(text) : parseIPv4(text);
  if (bytes === undefined) {
    throw new Error(`Invalid address range ${text}/${prefixLength}`);
  }
  return { bytes, prefixLength };
}

const BLOCKED_IPV4_RANGES: AddressRange[] = [
  range('0.0.0.0', 8),
  range('10.0.0.0', 8),
  range('100.64.0.0', 10),
  range('127.0.0.0', 8),
  range('169.254.0.0', 16),
  range('172.16.0.0', 12),
  range('192.0.0.0', 24),
  range('192.168.0.0', 16),
  range('198.18.0.0', 15),
  range('224.0.0.0', 4),
  range('240.0.0.0', 4),
];

const BLOCKED_IPV6_RANGES: AddressRange[] = [
  range('::', 128),
  range('::1', 128),
  range('fc00::', 7),
  range('fe80::', 10),
  range('fec0::', 10),
  range('ff00::', 8),
  // Local-use NAT64 (RFC 8215): how it maps to IPv4 is up to the local network, so the whole range
  range('64:ff9b:1::', 48),
  // Teredo (RFC 4380): it carries its IPv4 addresses obfuscated, so the whole range
  range('2001::', 32),
];

// IPv6 ranges that carry an IPv4 address, and the byte where that address starts
const IPV4_EMBEDDING_RANGES: { range: AddressRange; offset: number }[] = [
  { range: range('::ffff:0:0', 96), offset: 12 },
  // IPv4-translated (RFC 2765)
  { range: range('::ffff:0:0:0', 96), offset: 12 },
  { range: range('::', 96), offset: 12 },
  { range: range('64:ff9b::', 96), offset: 12 },
  { range: range('2002::', 16), offset: 2 },
];

function inRange(bytes: number[], addressRange: AddressRange): boolean {
  if (bytes.length !== addressRange.bytes.length) {
    return false;
  }
  let remaining = addressRange.prefixLength;
  for (let index = 0; index < bytes.length && remaining > 0; index += 1) {
    const bitCount = Math.min(8, remaining);
    const mask = (0xff << (8 - bitCount)) & 0xff;
    if ((bytes[index] & mask) !== (addressRange.bytes[index] & mask)) {
      return false;
    }
    remaining -= bitCount;
  }
  return true;
}

/**
 * Parses a dotted-decimal IPv4 address. Only the four-part decimal form is an address here;
 * URLs already normalize the other forms (0x7f.1, 2130706433) to it.
 */
export function parseIPv4(text: string): number[] | undefined {
  const parts = text.split('.');
  if (parts.length !== 4) {
    return undefined;
  }
  const bytes: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) {
      return undefined;
    }
    const value = Number(part);
    if (value > 255) {
      return undefined;
    }
    bytes.push(value);
  }
  return bytes;
}

/**
 * Parses an IPv6 address without brackets, including the :: shorthand and a dotted IPv4 tail.
 * A zone index (%eth0) is not an address of the public internet and does not parse.
 */
export function parseIPv6(text: string): number[] | undefined {
  if (text.length === 0 || text.includes('%')) {
    return undefined;
  }
  const halves = text.split('::');
  if (halves.length > 2) {
    return undefined;
  }

  const parseGroups = (part: string, allowIPv4Tail: boolean): number[] | undefined => {
    if (part === '') {
      return [];
    }
    const groups = part.split(':');
    const bytes: number[] = [];
    for (let index = 0; index < groups.length; index += 1) {
      const group = groups[index];
      if (allowIPv4Tail && index === groups.length - 1 && group.includes('.')) {
        const ipv4 = parseIPv4(group);
        if (ipv4 === undefined) {
          return undefined;
        }
        bytes.push(...ipv4);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/i.test(group)) {
        return undefined;
      }
      const value = Number.parseInt(group, 16);
      bytes.push(value >> 8, value & 0xff);
    }
    return bytes;
  };

  if (halves.length === 1) {
    const bytes = parseGroups(halves[0], true);
    return bytes !== undefined && bytes.length === 16 ? bytes : undefined;
  }

  const head = parseGroups(halves[0], false);
  const tail = parseGroups(halves[1], true);
  if (head === undefined || tail === undefined || head.length + tail.length > 14) {
    return undefined;
  }
  return [...head, ...new Array<number>(16 - head.length - tail.length).fill(0), ...tail];
}

function isBlockedIPv4(bytes: number[]): boolean {
  return BLOCKED_IPV4_RANGES.some((blockedRange) => inRange(bytes, blockedRange));
}

function isBlockedIPv6(bytes: number[]): boolean {
  if (BLOCKED_IPV6_RANGES.some((blockedRange) => inRange(bytes, blockedRange))) {
    return true;
  }
  for (const embedding of IPV4_EMBEDDING_RANGES) {
    if (inRange(bytes, embedding.range)) {
      return isBlockedIPv4(bytes.slice(embedding.offset, embedding.offset + 4));
    }
  }
  return false;
}

/**
 * Whether the code of a crawler may not reach the address. An address that does not parse is blocked.
 *
 * @param address - an IPv4 address, or an IPv6 address without brackets
 */
export function isBlockedAddress(address: string): boolean {
  const ipv4 = parseIPv4(address);
  if (ipv4 !== undefined) {
    return isBlockedIPv4(ipv4);
  }
  const ipv6 = parseIPv6(address);
  if (ipv6 !== undefined) {
    return isBlockedIPv6(ipv6);
  }
  return true;
}
