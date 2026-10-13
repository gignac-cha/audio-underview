import { describe, it, expect } from 'vitest';
import { isBlockedAddress, parseIPv4, parseIPv6 } from '../sources/crawler-runtime/address-policy.ts';

describe('isBlockedAddress', () => {
  it.each([
    '0.0.0.0', '0.255.255.255',
    '10.0.0.1', '10.255.255.255',
    '100.64.0.1', '100.127.255.255',
    '127.0.0.1', '127.255.255.254',
    '169.254.169.254',
    '172.16.0.1', '172.31.255.255',
    '192.0.0.1',
    '192.168.1.1',
    '198.18.0.1', '198.19.255.255',
    '224.0.0.1', '239.255.255.255',
    '240.0.0.1', '255.255.255.255',
  ])('blocks the IPv4 address %s', (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each(['1.1.1.1', '8.8.8.8', '93.184.216.34', '100.63.255.255', '100.128.0.0', '172.15.255.255', '172.32.0.0', '192.0.1.1', '198.17.255.255', '198.20.0.0', '223.255.255.255'])(
    'allows the public IPv4 address %s',
    (address) => {
      expect(isBlockedAddress(address)).toBe(false);
    },
  );

  it.each([
    '::', '::1',
    'fc00::1', 'fd00::1', 'fdff:ffff::1',
    'fe80::1', 'febf::1',
    'fec0::1', 'feff::1',
    'ff02::1', 'ff00::',
    // IPv4 inside IPv6, with a private IPv4 address
    '::ffff:7f00:1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:a9fe:a9fe',
    '::7f00:1', '::127.0.0.1', '::a00:1',
    '64:ff9b::a00:1', '64:ff9b::127.0.0.1',
    '2002:7f00:1::', '2002:a00:1:1::1', '2002:c0a8:101::',
  ])('blocks the IPv6 address %s', (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each([
    '2606:4700:4700::1111', '2001:4860:4860::8888',
    '::ffff:808:808', '::ffff:8.8.8.8', '64:ff9b::808:808', '2002:808:808::1', '::808:808',
  ])('allows the public IPv6 address %s', (address) => {
    expect(isBlockedAddress(address)).toBe(false);
  });

  it.each(['', 'localhost', 'example.com', '256.0.0.1', '1.2.3', '1.2.3.4.5', '01.02.03.004x', '::g', '1::2::3', 'fe80::1%eth0', '1:2:3:4:5:6:7:8:9', '[::1]'])(
    'blocks the address it cannot read: %j',
    (address) => {
      expect(isBlockedAddress(address)).toBe(true);
    },
  );
});

describe('parsing', () => {
  it('reads dotted IPv4 addresses', () => {
    expect(parseIPv4('192.168.0.1')).toEqual([192, 168, 0, 1]);
    expect(parseIPv4('192.168.0')).toBeUndefined();
  });

  it('reads the IPv6 forms', () => {
    expect(parseIPv6('::1')).toEqual([...new Array(15).fill(0), 1]);
    expect(parseIPv6('::ffff:127.0.0.1')).toEqual([...new Array(10).fill(0), 0xff, 0xff, 127, 0, 0, 1]);
    expect(parseIPv6('1:2:3:4:5:6:7:8')).toEqual([0, 1, 0, 2, 0, 3, 0, 4, 0, 5, 0, 6, 0, 7, 0, 8]);
    expect(parseIPv6('1:2:3:4:5:6:7::')).toEqual([0, 1, 0, 2, 0, 3, 0, 4, 0, 5, 0, 6, 0, 7, 0, 0]);
    expect(parseIPv6('1:2:3:4:5:6:7:8:9')).toBeUndefined();
    expect(parseIPv6('1:2:3:4:5:6:7')).toBeUndefined();
  });
});
