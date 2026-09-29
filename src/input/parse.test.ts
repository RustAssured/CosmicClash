import { describe, expect, it } from 'vitest';
import { browserFamily, parseGamepadId } from './parse';

describe('parseGamepadId', () => {
  it('parses Chrome-style ids with STANDARD GAMEPAD', () => {
    expect(parseGamepadId('Pro Controller (STANDARD GAMEPAD Vendor: 057e Product: 2009)')).toEqual({
      name: 'Pro Controller',
      vendor: 0x057e,
      product: 0x2009,
    });
  });
  it('parses Chrome-style ids without the mapping tag', () => {
    expect(parseGamepadId('Pro Controller (Vendor: 057e Product: 2009)')).toEqual({
      name: 'Pro Controller',
      vendor: 0x057e,
      product: 0x2009,
    });
  });
  it('parses Firefox-style ids, with and without leading zeros', () => {
    expect(parseGamepadId('057e-2009-Pro Controller')).toEqual({
      name: 'Pro Controller',
      vendor: 0x057e,
      product: 0x2009,
    });
    expect(parseGamepadId('57e-2006-Joy-Con (L)')).toEqual({
      name: 'Joy-Con (L)',
      vendor: 0x057e,
      product: 0x2006,
    });
    expect(parseGamepadId('54c-9cc-Wireless Controller')).toEqual({
      name: 'Wireless Controller',
      vendor: 0x054c,
      product: 0x09cc,
    });
  });
  it('handles ids with no vendor (Chrome XInput)', () => {
    const p = parseGamepadId('Xbox 360 Controller (XInput STANDARD GAMEPAD)');
    expect(p.vendor).toBeNull();
    expect(p.product).toBeNull();
    expect(p.name).toBe('Xbox 360 Controller');
  });
  it('never throws on junk', () => {
    expect(parseGamepadId('').name).toBe('');
    expect(parseGamepadId('   ').vendor).toBeNull();
    expect(parseGamepadId('a-b-c').vendor).toBeNull();
  });
});

describe('browserFamily', () => {
  it('classifies user agents', () => {
    expect(browserFamily('Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0')).toBe(
      'firefox',
    );
    expect(
      browserFamily('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36'),
    ).toBe('chrome');
    expect(browserFamily('Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Version/17.4 Safari/605.1.15')).toBe(
      'safari',
    );
    expect(browserFamily('')).toBe('other');
  });
});
