import { describe, it, expect } from 'vitest';
import { isBlockedAddress, parseIPv4, parseIPv6 } from '../sources/crawler-runtime/address-policy.ts';

// The edges of the ranges of the policy (design, section 5): both ends of each blocked range, the
// addresses just outside them, and the forms an IPv6 address can carry an IPv4 address in.

describe('the IPv4 ranges at both ends', () => {
  it.each([
    '0.0.0.0', '0.255.255.255',
    '10.0.0.0', '10.255.255.255',
    '100.64.0.0', '100.127.255.255',
    '127.0.0.0', '127.0.0.1', '127.255.255.255',
    '169.254.0.0', '169.254.169.254', '169.254.255.255',
    '172.16.0.0', '172.31.255.255',
    '192.0.0.0', '192.0.0.255',
    '192.168.0.0', '192.168.255.255',
    '198.18.0.0', '198.19.255.255',
    '224.0.0.0', '239.255.255.255',
    '240.0.0.0', '255.255.255.255',
  ])('blocks %s', (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each([
    '1.0.0.0', '8.8.8.8', '1.1.1.1', '9.255.255.255', '11.0.0.0',
    '100.63.255.255', '100.128.0.0',
    '126.255.255.255', '128.0.0.0',
    '169.253.255.255', '169.255.0.0',
    '172.15.255.255', '172.32.0.0',
    '192.0.1.0', '192.167.255.255', '192.169.0.0',
    '198.17.255.255', '198.20.0.0',
    '223.255.255.255',
  ])('allows %s, just outside a range', (address) => {
    expect(isBlockedAddress(address)).toBe(false);
  });
});

describe('the IPv6 ranges', () => {
  it.each([
    '::', '::1', '0:0:0:0:0:0:0:1', '0000:0000:0000:0000:0000:0000:0000:0001',
    'fc00::', 'fd00::1', 'FD00::1', 'fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
    'fe80::1', 'febf::1',
    'fec0::1', 'feff::1',
    'ff00::1', 'ff02::1',
  ])('blocks %s', (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each(['2606:4700:4700::1111', '2001:4860:4860::8888', '2001:db8::1', 'fbff::1', 'fe7f::1'])('allows %s', (address) => {
    expect(isBlockedAddress(address)).toBe(false);
  });
});

describe('an IPv4 address carried by an IPv6 address', () => {
  it.each([
    '::ffff:7f00:1', '::ffff:127.0.0.1', '::FFFF:7F00:1', '0:0:0:0:0:ffff:7f00:1', '0:0:0:0:0:ffff:127.0.0.1', '::ffff:0:0', '::ffff:a9fe:a9fe',
    '::7f00:1', '::127.0.0.1', '::a00:1',
    '64:ff9b::a00:1', '64:ff9b::10.0.0.1', '64:ff9b::7f00:1',
    '2002:7f00:1::', '2002:a00:1::1', '2002:c0a8:101::',
  ])('blocks %s when the carried address is blocked', (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each(['::ffff:808:808', '::ffff:8.8.8.8', '64:ff9b::808:808', '2002:808:808::1', '::808:808'])(
    'allows %s when the carried address is allowed',
    (address) => {
      expect(isBlockedAddress(address)).toBe(false);
    },
  );
});

describe('the IPv4-translated, local-use NAT64 and Teredo ranges', () => {
  it.each([
    // ::ffff:0:0:0/96 carries an IPv4 address in its last 32 bits
    '::ffff:0:7f00:1', '::ffff:0:127.0.0.1', '0:0:0:0:ffff:0:7f00:1', '::ffff:0:a00:1', '::ffff:0:a9fe:a9fe', '::ffff:0:0:0',
    // 64:ff9b:1::/48, whatever it carries
    '64:ff9b:1::', '64:ff9b:1::a00:1', '64:ff9b:1::808:808', '64:ff9b:1:ffff:ffff:ffff:ffff:ffff',
    // 2001::/32, whatever it carries
    '2001::', '2001:0:4136:e378:8000:63bf:80ff:fffe', '2001:0:ffff:ffff:ffff:ffff:ffff:ffff',
  ])('blocks %s', (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each([
    '::ffff:0:808:808', '::ffff:0:8.8.8.8',
    '::ffff:1:7f00:1', '::fffe:ffff:7f00:1',
    '64:ff9b:0:ffff:ffff:ffff:ffff:ffff', '64:ff9b:2::', '64:ff9b:2::a00:1',
    '2000:ffff:ffff:ffff:ffff:ffff:ffff:ffff', '2001:1::', '2001:1::a00:1',
  ])('allows %s, carrying an allowed address or just outside a range', (address) => {
    expect(isBlockedAddress(address)).toBe(false);
  });
});

describe('text that is not an address', () => {
  it.each([
    '', 'localhost', 'example.com', '1.2.3', '1.2.3.4.5', '256.0.0.1', '1.2.3.04x', '0x7f.0.0.1', ' 1.2.3.4', '1.2.3.-1', '1..2.3',
    ':::', ':', '1::2::3', '12345::', 'g::1', '1:2:3:4:5:6:7', '1:2:3:4:5:6:7:8:9', '1:2:3:4:5:6:7:8::', 'fe80::1%eth0',
    '::1.2.3', '::1.2.3.4.5', '::256.1.1.1', '[::1]', '127.0.0.1/8',
  ])('blocks %j', (text) => {
    expect(isBlockedAddress(text)).toBe(true);
  });

  it('is not read by the parsers either', () => {
    for (const text of ['', '1.2.3', '1.2.3.4.5', '256.1.1.1', '1.2.3.x', '0x7f.0.0.1']) {
      expect(parseIPv4(text), text).toBeUndefined();
    }
    for (const text of ['', ':', ':::', '1::2::3', '12345::', 'g::1', '1:2:3:4:5:6:7', '1:2:3:4:5:6:7:8:9', '[::1]', '127.0.0.1']) {
      expect(parseIPv6(text), text).toBeUndefined();
    }
  });
});

describe('the parsers', () => {
  it('read the forms of one IPv6 address to the same bytes', () => {
    const loopback = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1];
    expect(parseIPv6('::1')).toEqual(loopback);
    expect(parseIPv6('0:0:0:0:0:0:0:1')).toEqual(loopback);
    expect(parseIPv6('0000:0000:0000:0000:0000:0000:0000:0001')).toEqual(loopback);
    expect(parseIPv6('::0.0.0.1')).toEqual(loopback);
    expect(parseIPv6('::')).toEqual(new Array(16).fill(0));
    expect(parseIPv6('FD00::1')).toEqual(parseIPv6('fd00::1'));
    expect(parseIPv6('::ffff:127.0.0.1')).toEqual(parseIPv6('::ffff:7f00:1'));
    expect(parseIPv6('64:ff9b::10.0.0.1')).toEqual(parseIPv6('64:ff9b::a00:1'));
    expect(parseIPv6('1:2:3:4:5:6:1.2.3.4')).toEqual([0, 1, 0, 2, 0, 3, 0, 4, 0, 5, 0, 6, 1, 2, 3, 4]);
  });

  it('read a "::" at either end', () => {
    expect(parseIPv6('1::')).toEqual([0, 1, ...new Array(14).fill(0)]);
    expect(parseIPv6('1:2:3:4:5:6:7::')).toEqual([0, 1, 0, 2, 0, 3, 0, 4, 0, 5, 0, 6, 0, 7, 0, 0]);
    expect(parseIPv6('::2:3:4:5:6:7:8')).toEqual([0, 0, 0, 2, 0, 3, 0, 4, 0, 5, 0, 6, 0, 7, 0, 8]);
  });

  it('read four decimal bytes for IPv4', () => {
    expect(parseIPv4('127.0.0.1')).toEqual([127, 0, 0, 1]);
    expect(parseIPv4('255.255.255.255')).toEqual([255, 255, 255, 255]);
    expect(parseIPv4('0.0.0.0')).toEqual([0, 0, 0, 0]);
  });
});
