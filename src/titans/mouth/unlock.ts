/**
 * The Mouth (아귀) is the final boss (D35, D37): it is not in the normal character select until it is unlocked.
 *
 * - **Dev flag:** `?mouth=1` in the URL unlocks it for that session (WJ's test builds); `?mouth=0` locks it again.
 * - **Setting:** `setMouthUnlocked(true)` (the tournament ladder calls it when the boss falls) persists on this device
 *   (localStorage `adeuk.mouth.unlocked`).
 * - **Hook:** `isMouthUnlocked()` is what the menus read. Headless code (tests, tools) sees it locked unless they call
 *   `setMouthUnlocked(true, false)`.
 */
export const MOUTH_UNLOCK_KEY = 'adeuk.mouth.unlocked';

let session: boolean | null = null;

function urlFlag(): boolean | null {
  try {
    const q = new URLSearchParams(globalThis.location?.search ?? '').get('mouth');
    if (q === '1' || q === 'true') return true;
    if (q === '0' || q === 'false') return false;
  } catch {
    /* no location (Node) */
  }
  return null;
}

function stored(): boolean {
  try {
    return globalThis.localStorage?.getItem(MOUTH_UNLOCK_KEY) === '1';
  } catch {
    return false;
  }
}

/** Is the Mouth offered in the character select (and as a random / attract pick)? */
export function isMouthUnlocked(): boolean {
  if (session !== null) return session;
  return urlFlag() ?? stored();
}

/** Unlock (or lock) the Mouth. `persist` keeps it on this device; false = this session only. */
export function setMouthUnlocked(on: boolean, persist = true): void {
  session = on;
  if (!persist) return;
  try {
    if (on) globalThis.localStorage?.setItem(MOUTH_UNLOCK_KEY, '1');
    else globalThis.localStorage?.removeItem(MOUTH_UNLOCK_KEY);
  } catch {
    /* storage blocked: the session flag still holds */
  }
}
