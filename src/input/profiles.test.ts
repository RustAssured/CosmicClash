import { describe, expect, it } from 'vitest';
import {
  LAYOUT_JOYCON_DIRECTINPUT,
  LAYOUT_NINTENDO_DIRECTINPUT,
  LAYOUT_PLAYSTATION_LEGACY,
  LAYOUT_STANDARD,
  LAYOUT_XBOX_FIREFOX_LINUX,
  defaultRotation,
  detectProfile,
} from './profiles';

const FF = 'Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0';
const CH = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36';

describe('detectProfile', () => {
  it('recognises the Switch Pro Controller by vendor/product in both id styles', () => {
    for (const id of [
      'Pro Controller (STANDARD GAMEPAD Vendor: 057e Product: 2009)',
      '057e-2009-Pro Controller',
    ]) {
      const p = detectProfile(id, id.includes('STANDARD') ? 'standard' : '', CH);
      expect(p.kind).toBe('switch-pro');
      expect(p.family).toBe('nintendo');
      expect(p.name).toBe('Pro Controller');
    }
  });

  it('uses the W3C table for standard mapping and the DirectInput table otherwise', () => {
    expect(
      detectProfile('Pro Controller (STANDARD GAMEPAD Vendor: 057e Product: 2009)', 'standard').layout,
    ).toBe(LAYOUT_STANDARD);
    expect(detectProfile('057e-2009-Pro Controller', '', FF).layout).toBe(LAYOUT_NINTENDO_DIRECTINPUT);
  });

  it('recognises single and combined Joy-Cons', () => {
    expect(detectProfile('057e-2006-Joy-Con (L)', '').kind).toBe('joycon-l');
    expect(detectProfile('057e-2007-Joy-Con (R)', '').kind).toBe('joycon-r');
    expect(detectProfile('Joy-Con (L/R) (Vendor: 057e Product: 200e)', '').kind).toBe('joycon-pair');
    expect(detectProfile('Joy-Con (L) (Vendor: 057e Product: 2006)', '').layout).toBe(
      LAYOUT_JOYCON_DIRECTINPUT,
    );
    // name-only detection when the vendor is stripped
    expect(detectProfile('Joy-Con (R)', 'standard').kind).toBe('joycon-r');
  });

  it('marks single Joy-Cons sideways and gives non-standard ones a default quarter-turn', () => {
    const l = detectProfile('057e-2006-Joy-Con (L)', '');
    const r = detectProfile('057e-2007-Joy-Con (R)', '');
    expect(l.sideways && r.sideways).toBe(true);
    expect(defaultRotation(l)).toBe(3);
    expect(defaultRotation(r)).toBe(1);
    // standard mapping: the browser is believed to have rotated already
    expect(
      defaultRotation(detectProfile('Joy-Con (L) (STANDARD GAMEPAD Vendor: 057e Product: 2006)', 'standard')),
    ).toBe(0);
    expect(defaultRotation(detectProfile('Pro Controller (Vendor: 057e Product: 2009)', ''))).toBe(0);
  });

  it('recognises Xbox and PlayStation pads and picks browser-specific fallbacks', () => {
    expect(
      detectProfile('Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)', 'standard')
        .kind,
    ).toBe('xbox');
    expect(detectProfile('Xbox 360 Controller (XInput STANDARD GAMEPAD)', 'standard').kind).toBe('xbox');
    expect(detectProfile('45e-28e-Microsoft X-Box 360 pad', '', FF).layout).toBe(LAYOUT_XBOX_FIREFOX_LINUX);
    const ds = detectProfile('54c-9cc-Wireless Controller', '', FF);
    expect(ds.kind).toBe('playstation');
    expect(ds.layout).toBe(LAYOUT_PLAYSTATION_LEGACY);
  });

  it('falls back to a generic profile for unknown pads and keys persistence by vendor:product:layout', () => {
    const g = detectProfile('1234-abcd-Some Pad', '', FF);
    expect(g.kind).toBe('generic');
    expect(g.key).toBe('1234:abcd:generic-legacy');
    expect(detectProfile('Mystery', 'standard').key).toBe('generic:standard');
  });
});
