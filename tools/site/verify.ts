/**
 * Check the built site (dist/, from `npm run build:site`) in a headless browser and screenshot it into docs/gallery/site/.
 *
 *   npx tsx tools/site/verify.ts
 *
 * Checks: the page renders at desktop (1920×1080) and mobile (390×844); no console errors; clips below the fold are not
 * fetched until scrolled to; reduced motion fetches no hero video; Play opens the game at play/ and it becomes ready
 * (window.__ADEUK__.ready), with the link back to the site on its title screen.
 */
import { mkdirSync } from 'node:fs';
import type { Browser, BrowserContextOptions, Page } from '@playwright/test';
import { preview } from 'vite';
import { launch } from '../lead/browser';

const OUT = 'docs/gallery/site';
mkdirSync(OUT, { recursive: true });

const server = await preview({
  preview: { port: 4188, strictPort: false, host: '127.0.0.1' },
  build: { outDir: 'dist' },
});
const base = server.resolvedUrls!.local[0]!;
console.log(`serving dist at ${base}`);

const browser = await launch();
const problems: string[] = [];
const check = (ok: boolean, what: string): void => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) problems.push(what);
};

async function open(
  b: Browser,
  opts: BrowserContextOptions,
): Promise<{ page: Page; errors: string[]; media: string[] }> {
  const ctx = await b.newContext(opts);
  const page = await ctx.newPage();
  const errors: string[] = [];
  const media: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('requestfailed', (r) => {
    // a <video> whose source is swapped or paused aborts its range request; that is not an error
    if (!/\.(mp4|webm)$/.test(r.url())) errors.push(`request failed: ${r.url()}`);
  });
  page.on('response', (r) => {
    if (r.status() >= 400) errors.push(`${r.status()} ${r.url()}`);
  });
  page.on('request', (r) => {
    if (/\/media\/.*\.(mp4|webm)$/.test(r.url())) media.push(r.url().replace(base, ''));
  });
  await page.goto(base, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(1500);
  return { page, errors, media };
}

const unique = (a: string[]): string[] => [...new Set(a)];

// ---------------------------------------------------------------- desktop
{
  const { page, errors, media } = await open(browser, { viewport: { width: 1920, height: 1080 } });
  const first = unique(media);
  console.log(`  media fetched on load: ${first.join(', ') || 'none'}`);
  check(
    first.some((u) => u.includes('hero/loop')),
    'desktop: hero loop loads',
  );
  check(!first.some((u) => u.includes('titans/')), 'desktop: titan clips are not fetched on load');
  check(
    !first.some((u) => u.includes('features/sound') || u.includes('features/impact')),
    'desktop: lower feature clips wait',
  );
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${OUT}/desktop-hero.png` });
  check(
    await page.evaluate(() => !(document.getElementById('hero-video') as HTMLVideoElement).paused),
    'desktop: hero video plays',
  );

  // scroll through so lazy media arrives, then a full-page capture
  for (let y = 0; y < 12000; y += 700) {
    await page.evaluate((yy) => window.scrollTo(0, yy), y);
    await page.waitForTimeout(250);
  }
  check(
    unique(media).some((u) => u.includes('features/impact')),
    'desktop: feature clips load when scrolled to',
  );
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}/desktop-full.jpg`, fullPage: true, type: 'jpeg', quality: 82 });

  // a titan hovered
  const card = page.locator('.titan-card').nth(4);
  await card.scrollIntoViewIfNeeded();
  await card.hover();
  await page.waitForTimeout(1500);
  check(
    unique(media).some((u) => u.includes('titans/blackhole-loop')),
    'desktop: hovering a titan loads its clip',
  );
  await page.addStyleTag({ content: '.nav{display:none}' });
  await page.locator('#titans').screenshot({ path: `${OUT}/desktop-titans.png` });
  await page.locator('#press').screenshot({ path: `${OUT}/desktop-press.png` });
  await page.addStyleTag({ content: '.nav{display:flex}' });

  // the trailer lightbox
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.locator('[data-open-trailer]').first().click();
  await page.waitForTimeout(2000);
  check(
    await page.evaluate(() => (document.getElementById('trailer') as HTMLDialogElement).open),
    'desktop: trailer opens',
  );
  await page.screenshot({ path: `${OUT}/desktop-trailer.png` });
  await page.keyboard.press('Escape');

  // a screenshot lightbox
  await page.locator('.gallery button').first().click();
  await page.waitForTimeout(800);
  const w = await page.evaluate(
    () => (document.getElementById('shot-img') as HTMLImageElement).getBoundingClientRect().width,
  );
  check(
    Math.abs(w - 1280) < 1,
    `desktop: screenshot lightbox at an integer scale (${w} px = 640×${w / 640})`,
  );
  await page.keyboard.press('Escape');

  check(errors.length === 0, `desktop: no console errors${errors.length ? `: ${errors.join(' | ')}` : ''}`);
  await page.context().close();
}

// ---------------------------------------------------------------- mobile
{
  const { page, errors } = await open(browser, {
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}/mobile-hero.png` });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(overflow <= 0, `mobile: no horizontal scroll (overflow ${overflow}px)`);
  for (let y = 0; y < 20000; y += 600) {
    await page.evaluate((yy) => window.scrollTo(0, yy), y);
    await page.waitForTimeout(150);
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}/mobile-full.jpg`, fullPage: true, type: 'jpeg', quality: 80 });
  await page.addStyleTag({ content: '.nav{display:none}' });
  for (const id of ['titans', 'controls', 'press', 'follow'])
    await page.locator(`#${id}`).screenshot({ path: `${OUT}/mobile-${id}.png` });
  check(errors.length === 0, `mobile: no console errors${errors.length ? `: ${errors.join(' | ')}` : ''}`);
  await page.context().close();
}

// ---------------------------------------------------------------- reduced motion
{
  const { page, media } = await open(browser, {
    viewport: { width: 1280, height: 800 },
    reducedMotion: 'reduce',
  });
  check(
    unique(media).length === 0,
    `reduced motion: no clip autoloads (${unique(media).join(', ') || 'none'})`,
  );
  await page.context().close();
}

// ---------------------------------------------------------------- Play → the game at play/
{
  const { page, errors } = await open(browser, { viewport: { width: 1280, height: 720 } });
  await page.locator('.hero .btn-play').click();
  await page.waitForURL(/\/play\/$/);
  await page.waitForFunction(() => window.__ADEUK__?.ready === true, null, { timeout: 120_000 });
  check(true, `play: ${page.url()} is ready`);
  await page.waitForTimeout(1000);
  const screens: string[] = [];
  for (let i = 0; i < 2; i++) {
    const screen = await page.evaluate(() => window.__ADEUK__!.uiScreen());
    const back = await page.locator('#adeuk-home').isVisible();
    screens.push(screen);
    check(
      back === (screen === 'boot' || screen === 'title'),
      `play: back link ${back ? 'shown' : 'hidden'} on '${screen}'`,
    );
    await page.screenshot({ path: `${OUT}/play-${screen}.png` });
    await page.locator('canvas#game').click();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1500);
  }
  // into a menu: the link goes away
  await page.keyboard.press('Enter');
  await page.waitForTimeout(800);
  const deeper = await page.evaluate(() => window.__ADEUK__!.uiScreen());
  if (deeper !== 'title' && deeper !== 'boot')
    check(!(await page.locator('#adeuk-home').isVisible()), `play: back link hidden on '${deeper}'`);
  check(errors.length === 0, `play: no console errors${errors.length ? `: ${errors.join(' | ')}` : ''}`);
  await page.context().close();
}

await browser.close();
await new Promise<void>((r) => server.httpServer.close(() => r()));
console.log(problems.length ? `\n${problems.length} problem(s)` : '\nall checks passed');
process.exit(problems.length ? 1 : 0);
