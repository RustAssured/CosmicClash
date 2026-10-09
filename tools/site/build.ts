/**
 * `npm run build:site`: one deployable folder.
 *
 *   dist/            the landing page (a copy of site/)
 *   dist/play/       the game (vite build; base './' keeps every asset path relative, so it runs under any sub-path)
 *   dist/press/      the press kit, only when press/ exists locally (it is git-ignored, so CI builds go without it)
 *
 * It also adds a small "← ADEUK: TITANS" link back to the site on the game's title screen (dist/play/index.html only;
 * the dev entry is untouched), and fills the page's press-kit download list from press/ when there is one.
 */
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { build } from 'vite';

const DIST = 'dist';
const PLAY = join(DIST, 'play');

rmSync(DIST, { recursive: true, force: true });

// 1. the game
await build({ logLevel: 'warn', build: { outDir: PLAY, emptyOutDir: true } });

// 2. the landing page
cpSync('site', DIST, { recursive: true });
writeFileSync(join(DIST, '.nojekyll'), '');

// 3. the link back to the site, shown only on the boot ("press any button") and title screens
const BACK = `
    <a id="adeuk-home" href="../" tabindex="-1" aria-label="Back to the ADEUK: TITANS site" hidden>&larr; ADEUK: TITANS</a>
    <style>
      #adeuk-home{position:fixed;left:12px;top:10px;z-index:10;padding:4px 8px;border-radius:3px;
        font:12px/1.2 ui-monospace,Consolas,monospace;letter-spacing:.06em;color:#a8bdb2;text-decoration:none;
        background:rgba(4,5,10,.55);opacity:.55;transition:opacity .2s}
      #adeuk-home:hover{opacity:1;color:#fff}
    </style>
    <script>
      (function () {
        var a = document.getElementById('adeuk-home');
        setInterval(function () {
          var h = window.__ADEUK__;
          var s = h && h.ready && h.uiScreen ? h.uiScreen() : '';
          a.hidden = s !== 'boot' && s !== 'title';
        }, 400);
      })();
    </script>
  </body>`;
const gameHtml = join(PLAY, 'index.html');
writeFileSync(gameHtml, readFileSync(gameHtml, 'utf8').replace('</body>', BACK.trimStart()));

// 4. the press kit (local builds only)
const PRESS = 'press';
if (existsSync(PRESS)) {
  const files = walk(PRESS).filter((f) => !f.split(sep).includes('work') && !f.endsWith('.json'));
  if (files.length) {
    cpSync(PRESS, join(DIST, 'press'), {
      recursive: true,
      filter: (src) => !src.split(sep).includes('work'),
    });
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
