import { expect, test, type Page } from '@playwright/test';

/**
 * Netplay Step 1 (docs/netplay/STEP1.md §5): an online match between two pages over the local loopback, with simulated
 * latency, jitter and loss. Each page's own slot is played by an AI (`netai`), the host picks the stage, and both pages
 * must agree on the checksum of every tick and on the full state hash.
 *
 * The two pages run in two separate browsers (two GPU processes: on software GL one browser cannot render two matches at
 * a useful rate), joined by the test as the transport: `?net=bridge` is the BroadcastChannel loopback with the channel
 * replaced by `__adeukBridgeOut` / `__adeukBridgeIn`. The manual two-tab test uses `?net=local` (STEP1.md §5).
 */
interface NetApi {
  view(): { phase: string; error: { en: string; detail?: string } | null };
  simTick(): number;
  checksumAt(t: number): number | null;
  hashAt(t: number): number | null;
  desync(): unknown;
}
declare global {
  interface Window {
    __ADEUK_NET__?: NetApi;
    __adeukBridgeIn?: (json: string) => void;
  }
}

/** Ticks both pages must play (2 s of game time by default; NET_TICKS=600 for a longer run). */
const TICKS = Math.max(120, Number(process.env.NET_TICKS ?? 120));

const errorsOf = (page: Page, out: string[]): void => {
  page.on('console', (m) => {
    // the renderer's software-GL performance notes are not failures; anything else logged as an error is
    if (m.type() === 'error') out.push(`[console.error] ${m.text()}`);
  });
  page.on('pageerror', (e) => out.push(`[pageerror] ${e.message}`));
};

/** Deliver `from`'s outgoing messages to `to`, batched (one evaluate in flight at a time, order kept). */
async function wire(from: Page, to: Page): Promise<void> {
  let pending: string[] = [];
  let busy = false;
  const pump = async (): Promise<void> => {
    if (busy || !pending.length) return;
    busy = true;
    const batch = `[${pending.join(',')}]`;
    pending = [];
    await to.evaluate((j) => window.__adeukBridgeIn?.(j), batch).catch(() => undefined);
    busy = false;
    void pump();
  };
  await from.exposeFunction('__adeukBridgeOut', (json: string) => {
    pending.push(json);
    void pump();
  });
}

const tickOf = (p: Page): Promise<number> => p.evaluate(() => window.__ADEUK_NET__?.simTick() ?? 0);

test('two pages in lockstep over a lossy loopback agree on every tick', async ({ browser, playwright }) => {
  test.setTimeout(420_000);
  const second = await playwright.chromium.launch(test.info().project.use.launchOptions ?? {});
  const viewport = { width: 480, height: 270 };
  const host = await (await browser.newContext({ viewport })).newPage();
  const guest = await (await second.newContext({ viewport })).newPage();
  const errs: string[] = [];
  errorsOf(host, errs);
  errorsOf(guest, errs);
  await wire(host, guest);
  await wire(guest, host);
  const code = 'E2ETST';
  // 25 ms ± 15 ms one way, 10 % of input packets lost; delay 6 so the slow software-GL pages keep a usable tick rate
  const common = 'net=bridge&netsim=25,15,0.1&netai=4&netdelay=6&q=0';
  await Promise.all([
    host.goto(`/?${common}&host=${code}&netpick=planet&netstage=nursery`),
    guest.goto(`/?${common}&room=${code}&netpick=lastone`),
  ]);

  // select → stage → countdown → match, then TICKS ticks in lockstep
  await expect
    .poll(async () => Math.min(await tickOf(host), await tickOf(guest)), {
      timeout: 360_000,
      intervals: [2000],
    })
    .toBeGreaterThanOrEqual(TICKS);

  for (const p of [host, guest]) {
    const v = await p.evaluate(() => window.__ADEUK_NET__!.view());
    expect(v.error, JSON.stringify(v.error)).toBeNull();
    expect(v.phase).toBe('match');
    expect(await p.evaluate(() => window.__ADEUK_NET__!.desync())).toBeNull();
  }
  const sums = (p: Page): Promise<(number | null)[]> =>
    p.evaluate((n) => Array.from({ length: n }, (_, i) => window.__ADEUK_NET__!.checksumAt(i + 1)), TICKS);
  const a = await sums(host);
  const b = await sums(guest);
  expect(a.every((x) => typeof x === 'number')).toBe(true);
  const first = a.findIndex((x, i) => x !== b[i]);
  expect(first, `first differing tick ${first + 1}`).toBe(-1);
  // the full state hash (every 60 ticks) agrees too
  const hashes = (p: Page): Promise<(number | null)[]> =>
    p.evaluate(
      (n) => Array.from({ length: Math.floor(n / 60) }, (_, i) => window.__ADEUK_NET__!.hashAt((i + 1) * 60)),
      TICKS,
    );
  const ha = await hashes(host);
  expect(ha.every((x) => typeof x === 'number')).toBe(true);
  expect(ha).toEqual(await hashes(guest));
  expect(errs).toEqual([]);
  await second.close();
});
