/**
 * Gamepad id parsing. Browsers disagree on the `Gamepad.id` format:
 *   Chrome / Edge   `Pro Controller (STANDARD GAMEPAD Vendor: 057e Product: 2009)`  (or without STANDARD GAMEPAD)
 *   Firefox         `057e-2009-Pro Controller`   (Windows/macOS strip leading zeros: `57e-2009-…`)
 *   Safari          `Pro Controller (STANDARD GAMEPAD Vendor: 057e Product: 2009)` or the Firefox style
 *   Chrome/XInput   `Xbox 360 Controller (XInput STANDARD GAMEPAD)`  — no vendor/product at all
 */
export interface ParsedPadId {
  vendor: number | null;
  product: number | null;
  /** Human name with the vendor/product decoration removed. */
  name: string;
}

const CHROME_RE = /^(.*?)\s*\((?:[^()]*?\s)?Vendor:\s*([0-9a-f]{1,4})\s+Product:\s*([0-9a-f]{1,4})\)\s*$/i;
const CHROME_LOOSE_RE = /Vendor:\s*([0-9a-f]{1,4})\s+Product:\s*([0-9a-f]{1,4})/i;
const FIREFOX_RE = /^([0-9a-f]{2,4})-([0-9a-f]{1,4})-(.+)$/i;
const PAREN_TAIL_RE = /\s*\((?:[^()]*?(?:STANDARD GAMEPAD|XInput)[^()]*?)\)\s*$/i;

export function parseGamepadId(id: string): ParsedPadId {
  const s = (id ?? '').trim();
  let m = CHROME_RE.exec(s);
  if (m) return { name: m[1]!.trim() || s, vendor: parseInt(m[2]!, 16), product: parseInt(m[3]!, 16) };
  m = FIREFOX_RE.exec(s);
  if (m) return { name: m[3]!.trim(), vendor: parseInt(m[1]!, 16), product: parseInt(m[2]!, 16) };
  const loose = CHROME_LOOSE_RE.exec(s);
  if (loose) {
    return {
      name: s.replace(/\(.*$/, '').trim() || s,
      vendor: parseInt(loose[1]!, 16),
      product: parseInt(loose[2]!, 16),
    };
  }
  return { name: s.replace(PAREN_TAIL_RE, '').trim() || s, vendor: null, product: null };
}

export type BrowserFamily = 'chrome' | 'firefox' | 'safari' | 'other';

export function browserFamily(userAgent: string): BrowserFamily {
  const ua = userAgent ?? '';
  if (/firefox\//i.test(ua)) return 'firefox';
  if (/(chrome|chromium|crios|edg)\//i.test(ua)) return 'chrome';
  if (/safari\//i.test(ua) && /version\//i.test(ua)) return 'safari';
  return 'other';
}

export const hex4 = (n: number | null): string => (n === null ? '----' : n.toString(16).padStart(4, '0'));
