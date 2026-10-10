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
  // the page scrolls smoothly; the checks jump straight to where they look
  await page.addStyleTag({ content: 'html{scroll-behavior:auto!important}' });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(1500);
  return { page, errors, media };
}

const unique = (a: string[]): string[] => [...new Set(a)];
/** ONLY=story,play (comma list) runs a subset: desktop, story, mobile, reduced, play. */
const want = (g: string): boolean => !process.env.ONLY || process.env.ONLY.split(',').includes(g);

// ---------------------------------------------------------------- desktop
if (want('desktop')) {
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
  // (hidden until the v2 trailer exists: tools/site/build.ts shows it when media/trailer/trailer-60.mp4 is there)
  await page.evaluate(() => window.scrollTo(0, 0));
  const tb = page.locator('[data-open-trailer]').first();
  if (await tb.isVisible()) {
    await tb.click();
    await page.waitForTimeout(2000);
    check(
      await page.evaluate(() => (document.getElementById('trailer') as HTMLDialogElement).open),
      'desktop: trailer opens',
    );
    await page.screenshot({ path: `${OUT}/desktop-trailer.png` });
    await page.keyboard.press('Escape');
  } else {
    const res = await page.request.get(`${base}media/trailer/trailer-60.mp4`);
    const isVideo = res.ok() && (res.headers()['content-type'] ?? '').includes('video');
    check(!isVideo, 'desktop: no trailer yet, and the trailer button is hidden');
  }

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

// ---------------------------------------------------------------- the story layer: prologue, scale reveal, the Edge
/** Scroll so a pinned section is at progress p (0..1 of its scroll length). */
async function scrollTo(page: Page, sel: string, p: number): Promise<void> {
  await page.evaluate(
    ([s, pp]) => {
      const el = document.querySelector(s as string) as HTMLElement;
      const top = el.getBoundingClientRect().top + scrollY;
      window.scrollTo(0, top + (pp as number) * Math.max(0, el.offsetHeight - innerHeight));
    },
    [sel, p],
  );
}

/** Frames per second and the worst frame over `ms`, measured with rAF. */
// (in-page code is passed as strings: tsx's keepNames would inject a `__name` helper the page does not have)
async function fps(page: Page, ms = 1500): Promise<{ fps: number; worst: number; p95: number }> {
  return page.evaluate(`new Promise((res) => {
    const ts = [];
    const t0 = performance.now();
    function tick(t) {
      ts.push(t);
      if (t - t0 < ${ms}) return requestAnimationFrame(tick);
      const d = ts.slice(1).map((v, i) => v - ts[i]);
      const s = [...d].sort((a, b) => a - b);
      res({
        fps: Math.round((d.length / (ts[ts.length - 1] - ts[0])) * 1000),
        worst: Math.round(s[s.length - 1] || 0),
        p95: Math.round(s[Math.floor(s.length * 0.95)] || 0),
      });
    }
    requestAnimationFrame(tick);
  })`);
}

/** How many times the story canvases were redrawn during one second. */
const storyDraws = (page: Page): Promise<number> =>
  page.evaluate(`new Promise((res) => {
    let n = 0;
    const orig = CanvasRenderingContext2D.prototype.putImageData;
    CanvasRenderingContext2D.prototype.putImageData = function (...a) {
      if (this.canvas.classList.contains('story-cv')) n++;
      return orig.apply(this, a);
    };
    setTimeout(() => {
      CanvasRenderingContext2D.prototype.putImageData = orig;
      res(n);
    }, 1000);
  })`);

/** story.js's own measure: smoothed ms per frame of drawing, the resolution step and the canvas size. */
const drawCost = (page: Page, id: string): Promise<string> =>
  page.evaluate(
    `(() => { const s = (window.__story || {})['${id}']; return s ? s.ms + ' ms at ' + s.w + 'x' + s.h + ' (step +' + s.boost + ')' : '?'; })()`,
  );

const onIndex = (page: Page, sel: string): Promise<number> =>
  page.evaluate((s) => [...document.querySelectorAll(s)].findIndex((e) => e.classList.contains('on')), sel);

async function story(page: Page, tag: string): Promise<void> {
  const perf: string[] = [];
  // prologue: five beats, one per fifth of the section's scroll
  for (let i = 0; i < 5; i++) {
    await scrollTo(page, '#prologue', (i + 0.5) / 5);
    await page.waitForTimeout(1300);
    check(
      (await onIndex(page, '#prologue [data-beat]')) === i,
      `${tag}: prologue beat ${i + 1} shows its caption`,
    );
    await page.screenshot({ path: `${OUT}/${tag}-prologue-${i + 1}.png` });
    const f = await fps(page);
    perf.push(
      `beat ${i + 1}: ${f.fps} fps (p95 ${f.p95} ms, worst ${f.worst} ms) draw ${await drawCost(page, 'prologue')}`,
    );
  }
  // the opt-in soundscape: on, still there (ambient.js loaded and started), off again
  const amb = page.locator('[data-ambient]');
  await amb.click();
  await page.waitForTimeout(1200);
  const ambOn = (await amb.getAttribute('aria-pressed')) === 'true' && (await amb.isVisible());
  check(ambOn, `${tag}: the prologue's sound toggle turns the soundscape on`);
  await amb.click();
  await page.waitForTimeout(300);
  // scale reveal: Earth → Planet → arena → the Mouth
  for (let i = 0; i < 4; i++) {
    await scrollTo(page, '#scale', Math.min(1, (i + 0.15) / 3.4));
    await page.waitForTimeout(900);
    check((await onIndex(page, '#scale [data-cap]')) === i, `${tag}: scale caption ${i + 1} shows`);
    await page.screenshot({ path: `${OUT}/${tag}-scale-${i + 1}.png` });
    const f = await fps(page);
    perf.push(
      `scale ${i + 1}: ${f.fps} fps (p95 ${f.p95} ms, worst ${f.worst} ms) draw ${await drawCost(page, 'scale')}`,
    );
  }
  // the Edge: the four words land
  await page.evaluate(() => document.getElementById('edge')!.scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(3800);
  const words = await page.evaluate(() => document.querySelectorAll('#edge [data-word].on').length);
  check(words === 4, `${tag}: the Edge's four words land (${words})`);
  await page.screenshot({ path: `${OUT}/${tag}-edge.png` });
  const f = await fps(page);
  perf.push(`edge: ${f.fps} fps (p95 ${f.p95} ms, worst ${f.worst} ms) draw ${await drawCost(page, 'edge')}`);
  // canvases idle when off screen: no story canvas is drawn while the page sits at the controls
  await page.evaluate(() => document.getElementById('controls')!.scrollIntoView());
  await page.waitForTimeout(1200);
  const idle = await storyDraws(page);
  check(idle === 0, `${tag}: story canvases idle while off screen (${idle} draws in 1 s)`);
  for (const p of perf) console.log(`  ${tag} ${p}`);
}

if (want('story')) {
  const { page, errors } = await open(browser, { viewport: { width: 1920, height: 1080 } });
  await story(page, 'desktop');
  check(
    errors.length === 0,
    `desktop story: no console errors${errors.length ? `: ${errors.join(' | ')}` : ''}`,
  );
  await page.context().close();
}
if (want('story')) {
  const { page, errors } = await open(browser, {
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
  await story(page, 'mobile');
  check(
    errors.length === 0,
    `mobile story: no console errors${errors.length ? `: ${errors.join(' | ')}` : ''}`,
  );
  await page.context().close();
}

// ---------------------------------------------------------------- mobile
if (want('mobile')) {
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
if (want('reduced')) {
  const { page, media } = await open(browser, {
    viewport: { width: 1280, height: 800 },
    reducedMotion: 'reduce',
  });
  check(
    unique(media).length === 0,
    `reduced motion: no clip autoloads (${unique(media).join(', ') || 'none'})`,
  );
  check(
    await page.evaluate(() => document.documentElement.classList.contains('story-static')),
    'reduced motion: story-static is set',
  );
  const shown = await page.evaluate(
    () =>
      [...document.querySelectorAll('[data-beat], [data-cap], #edge [data-word]')].filter(
        (e) => getComputedStyle(e).opacity === '1',
      ).length,
  );
  check(shown === 13, `reduced motion: every beat, caption and word is shown (${shown}/13)`);
  await page.evaluate(() => document.getElementById('prologue')!.scrollIntoView());
  await page.waitForTimeout(600);
  const draws = await storyDraws(page);
  check(draws === 0, `reduced motion: story canvases hold a still frame (${draws} redraws in 1 s)`);
  await page.addStyleTag({ content: '.nav{display:none}' });
  await page.locator('#prologue').screenshot({ path: `${OUT}/reduced-prologue.png` });
  await page.locator('#scale').screenshot({ path: `${OUT}/reduced-scale.png` });
  await page.context().close();
}

// ---------------------------------------------------------------- Play → the game at play/
if (want('play')) {
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
