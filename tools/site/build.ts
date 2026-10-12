/**
 * `npm run build:site`: one deployable folder.
 *
 *   dist/            the landing page (a copy of site/)
 *   dist/play/       the game (vite build; base './' keeps every asset path relative, so it runs under any sub-path)
 *   dist/press/      the press kit, only when press/ exists locally (it is git-ignored, so CI builds go without it)
 *
 * The landing page's titan cards are generated from the roster on every build (tools/site/roster.ts).
 * It also adds a small "← ADEUK: TITANS" link back to the site on the game's title screen (dist/play/index.html only;
 * the dev entry is untouched), and fills the page's press-kit download list from press/ when there is one.
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, relative, sep } from 'node:path';
import { build } from 'vite';
import { SITE_ROSTER } from '@/titans/roster';
import { injectRoster } from './roster';

const DIST = 'dist';
const PLAY = join(DIST, 'play');

rmSync(DIST, { recursive: true, force: true });

// 1. the game
await build({ logLevel: 'warn', build: { outDir: PLAY, emptyOutDir: true } });

// 2. the landing page
cpSync('site', DIST, { recursive: true });
writeFileSync(join(DIST, '.nojekyll'), '');
// the titan cards, generated from the roster (src/titans/roster.ts + site/media/titans/{sizes,matter}.json)
{
  const page = join(DIST, 'index.html');
  writeFileSync(page, await injectRoster(readFileSync(page, 'utf8')));
  console.log(`titans: ${SITE_ROSTER.length} cards from the roster`);
  for (const r of SITE_ROSTER)
    for (const f of [`titans/${r.site.file}.png`, `type/ko-${r.site.file}.png`])
      if (!existsSync(join('site', 'media', f)))
        console.warn(`titans: site/media/${f} is missing (run \`npm run site:art -- --only=${r.id}\`)`);
}

// 3. the link back to the site, shown only while loading and on the boot ("press any button") and title screens
const BACK = `
    <a id="adeuk-home" href="../" tabindex="-1" aria-label="Back to the ADEUK: TITANS site">&larr; ADEUK: TITANS</a>
    <style>
      #adeuk-home{position:fixed;left:14px;top:12px;z-index:10;padding:6px 10px;border-radius:3px;
        border:1px solid rgba(168,189,178,.28);font:400 12px/1 var(--label,'Silkscreen',ui-monospace,monospace);
        letter-spacing:.06em;color:#a8bdb2;text-decoration:none;background:rgba(7,4,15,.7);opacity:.85;transition:opacity .2s}
      #adeuk-home:hover{opacity:1;color:#fff;border-color:#ffd27a}
    </style>
    <script>
      (function () {
        // shown while the game loads and on its boot / title screens; hidden in menus and play
        var a = document.getElementById('adeuk-home');
        setInterval(function () {
          var h = window.__ADEUK__;
          var s = h && h.ready && h.uiScreen ? h.uiScreen() : '';
          a.hidden = s !== '' && s !== 'boot' && s !== 'title';
        }, 400);
      })();
    </script>
  </body>`;
const gameHtml = join(PLAY, 'index.html');
writeFileSync(gameHtml, readFileSync(gameHtml, 'utf8').replace('</body>', BACK.trimStart()));

// 4. the press kit (local builds only)
const PRESS = 'press';
if (existsSync(PRESS)) {
  // only finished deliverables: no work/ folder, no audio stems, mix drafts or JSON notes
  const DELIVERABLE = /\.(mp4|webm|gif|png|jpe?g|webp|zip|pdf|txt|md)$/i;
  // …and nothing over 60 MB: production masters (a 1080p60 trailer at CRF 14 is ~450 MB) are not web downloads
  const MAX = 60 * 1048576;
  const isDeliverable = (f: string): boolean =>
    !f.split(sep).includes('work') &&
    DELIVERABLE.test(f) &&
    !/draft|stem/i.test(f) &&
    statSync(f).size <= MAX;
  const big = walk(PRESS).filter((f) => DELIVERABLE.test(f) && statSync(f).size > MAX);
  if (big.length)
    console.log(`press kit: left out ${big.length} master file(s) over 60 MB: ${big.join(', ')}`);
  const files = walk(PRESS).filter(isDeliverable);
  if (files.length) {
    for (const f of files) {
      const to = join(DIST, f);
      mkdirSync(join(to, '..'), { recursive: true });
      cpSync(f, to);
    }
    const items = files
      .map((f) => {
        const rel = relative('.', f).split(sep).join('/');
        const kb = statSync(f).size / 1024;
        const size = kb > 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${Math.round(kb)} KB`;
        return `              <li><a href="${rel}" download>${label(rel)} <small>(${size})</small></a></li>`;
      })
      .join('\n');
    const page = join(DIST, 'index.html');
    const html = readFileSync(page, 'utf8').replace(
      /(<ul class="downloads" data-press-list>)[\s\S]*?(<\/ul>)/,
      `$1\n${items}\n            $2`,
    );
    writeFileSync(page, html);
    console.log(`press kit: ${files.length} files linked`);
  }
} else console.log('press kit: press/ not found, the page keeps its built-in download list');

// 5. the trailer: the site plays its own web encode, site/media/trailer/trailer.{webm,mp4,jpg} (`npm run site:media
// trailer` makes it from the current master: the story teaser until S5's converged trailer is delivered). The
// "Watch the trailer" button and its download link are shown only when that file exists.
const TR = join(DIST, 'media', 'trailer', 'trailer.mp4');
if (existsSync(TR)) {
  const page = join(DIST, 'index.html');
  const html = readFileSync(page, 'utf8')
    .replace(/(<button[^>]*data-open-trailer)\s+hidden/g, '$1')
    .replace(/(<li data-trailer-link)\s+hidden/g, '$1');
  writeFileSync(page, html);
  const mb = statSync(TR).size / 1048576;
  console.log(
    `trailer: shown (${mb.toFixed(1)} MB${mb > 15 ? ': over the 15 MB web budget, re-encode' : ''})`,
  );
} else console.log('trailer: no media/trailer/trailer.mp4 yet, so the trailer button stays hidden');

console.log(
  `site: ${(dirSize(DIST) / 1048576).toFixed(1)} MB in ${DIST}/ (game ${(dirSize(PLAY) / 1048576).toFixed(1)} MB)`,
);

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
  );
}

function dirSize(dir: string): number {
  return walk(dir).reduce((n, f) => n + statSync(f).size, 0);
}

/** "press/stills/witness-vs-planet_4k.png" → "Stills: witness vs planet 4k (PNG)" */
function label(rel: string): string {
  const parts = rel.split('/').slice(1);
  const file = parts.pop()!;
  const ext = file.split('.').pop()!.toUpperCase();
  const name = file.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ');
  const group = parts.length ? `${parts.join(' / ').replace(/[-_]+/g, ' ')}: ` : '';
  const s = `${group}${name}`;
  return `${s.charAt(0).toUpperCase()}${s.slice(1)} (${ext})`;
}
