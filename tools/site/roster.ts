/**
 * The landing page's titan cards, generated from the roster (src/titans/roster.ts: name, Korean, essence, tagline, lore,
 * mechanic, accents, portrait, clip) and the matter counts (site/media/titans/matter.json, `npm run site:matter`).
 *
 *   npx tsx tools/site/roster.ts      # regenerate the cards in site/index.html (so the source page previews as built)
 *
 * `npm run build:site` (tools/site/build.ts) regenerates them into dist/index.html on every build, so a new roster titan
 * shows up on the site with no hand edits. The cards sit between the `roster:begin` / `roster:end` markers; edit the copy in
 * src/titans/roster.ts (or a kit titan's JSON `kit.site`), not in the page.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { format } from 'prettier';
import { DEFAULT_LIGHTING, type MatterMap, type TitanId } from '@/contracts';
import { generateTitanBody, getTitanDef, isUriDef, isWitnessDef } from '@/titans';
import type { UriTitanRig, WitnessTitanRig } from '@/titans';
import { SITE_ROSTER, type RosterEntry } from '@/titans/roster';

export const MATTER_JSON = 'site/media/titans/matter.json';
const SIZES_JSON = 'site/media/titans/sizes.json';

const cells = (m: MatterMap): number => {
  let n = 0;
  for (let i = 0; i < m.material.length; i++) if (m.material[i] !== 0) n++;
  return n;
};

/** Cells of simulated matter in a titan's whole body at seed 1 (every region / part of a multi-body titan). */
export function countMatter(id: TitanId): number {
  const def = getTitanDef(id);
  const body = generateTitanBody(def, 1, DEFAULT_LIGHTING);
  if (isWitnessDef(def))
    return (body.rig as WitnessTitanRig).body.regions.reduce((s, r) => s + cells(r.map), 0);
  if (isUriDef(def)) return (body.rig as UriTitanRig).parts.reduce((s, p) => s + cells(p.map), 0);
  // a kit titan with a rig (the Cradle: the knot is the body map, the disc and the cord links are rig regions)
  const regions = (body.rig as { regions?: { map: MatterMap }[] } | undefined)?.regions;
  if (regions?.length) return regions.reduce((s, r) => s + cells(r.map), 0);
  return cells(body.map);
}

const readJson = <T>(path: string): T | null =>
  existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as T) : null;

/** A PNG's width and height from its header (no decode). */
function pngSize(path: string): [number, number] | null {
  if (!existsSync(path)) return null;
  const b = readFileSync(path);
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
}

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const WORDS = [
  'No',
  'One',
  'Two',
  'Three',
  'Four',
  'Five',
  'Six',
  'Seven',
  'Eight',
  'Nine',
  'Ten',
  'Eleven',
  'Twelve',
  'Thirteen',
  'Fourteen',
  'Fifteen',
  'Sixteen',
  'Seventeen',
  'Eighteen',
  'Nineteen',
  'Twenty',
];
const word = (n: number): string => WORDS[n] ?? String(n);

function card(r: RosterEntry, size: [number, number], matter: number | undefined, max: number): string {
  const s = r.site;
  const [w, h] = size;
  const cls =
    s.portrait === 'half' ? 'portrait half' : s.portrait === 'x2' ? 'px portrait x2' : 'px portrait';
  const wStyle = s.portrait === 'x2' ? ` style="--w: ${w}"` : '';
  const aria = s.aria ?? (s.clip ? `${s.name}: play its clip` : s.name);
  const video = s.clip
    ? `<video muted loop playsinline preload="none" data-titan-clip>
        <source data-src="media/titans/${s.file}-loop.webm" type="video/webm" />
        <source data-src="media/titans/${s.file}-loop.mp4" type="video/mp4" />
      </video>`
    : '';
  const ko = pngSize(`site/media/type/ko-${s.file}.png`) ?? [s.ko.length * 14, 14];
  const m = matter != null ? Number((matter / max).toFixed(3)) : 0;
  const matterSpan =
    matter != null
      ? `<span class="titan-matter" data-titan="${s.file}" style="--m: ${m}"><b>MATTER</b> ${matter.toLocaleString('en-US')} px</span>`
      : '';
  return `<li class="titan" style="--accent: ${s.accent}; --accent2: ${s.accent2}">
  <button class="titan-card" type="button" aria-label="${esc(aria)}">
    <span class="titan-media">
      <img class="${cls}"${wStyle} src="media/titans/${s.file}.png" width="${w}" height="${h}" alt="" loading="lazy" />
      ${video}
    </span>
    <span class="titan-text">
      <span class="titan-essence">${esc(s.essence)}</span>
      <span class="titan-name">${esc(s.name)}</span>
      <img class="px ko" src="media/type/ko-${s.file}.png" width="${ko[0]}" height="${ko[1]}" alt="${esc(s.ko)}" lang="ko" />
      ${matterSpan}${s.tag ? `\n      <span class="titan-tag">${esc(s.tag)}</span>` : ''}
      <span class="titan-lore">${esc(s.lore)}</span>
      <span class="titan-mech"><b>${esc(s.mech.title)}</b> ${esc(s.mech.text)}</span>
    </span>
  </button>
</li>`;
}

/**
 * The final boss's teaser card, after the titans. It fills the last row at every column count (4 / 3 / 2): `--span-N` is how
 * many columns it spans at N columns; spanning two or more, it lays out as a wide, featured banner (site/style.css).
 */
function mystery(n: number): string {
  const span = (c: number): number => (n % c === 0 ? c : c - (n % c));
  return `<li class="titan mystery" style="--accent: #8a3cff; --accent2: #ff4d6d; --span-4: ${span(4)}; --span-3: ${span(3)}; --span-2: ${span(2)}">
  <a class="titan-card" href="#edge" aria-label="A final boss is coming: see what is at the edge">
    <span class="titan-media">
      <span class="jaw" aria-hidden="true"></span>
    </span>
    <span class="titan-text">
      <span class="titan-essence">hunger</span>
      <span class="titan-name">???</span>
      <span class="ko-text" lang="ko">???</span>
      <span class="titan-tag">“A final boss is coming…”</span>
      <span class="titan-mech">Something vast is opening at the edge of the arena. It does not fight fair.</span>
      <span class="titan-more">Look at the edge →</span>
    </span>
  </a>
</li>`;
}

export const COSMIC_BEGIN =
  '<!-- cosmic:begin (generated by tools/site/roster.ts: the COSMIC CLASH banner and its live titan count) -->';
export const COSMIC_END = '<!-- cosmic:end -->';
/** Frames in site/media/type/cosmicclash-sheet.png (tools/site/art.ts COSMIC_FRAMES). */
const COSMIC_FRAMES = 32;

/**
 * The COSMIC CLASH banner under the titan cards: the game's living wordmark (a sprite sheet stepped in CSS), 우주 대결, the
 * live badge "N TITANS · GROWING" counted from the roster on every build, and a line on what the mode is.
 */
export function cosmicBanner(n: number): string {
  const mark = pngSize('site/media/type/cosmicclash.png') ?? [233, 31];
  const ko = pngSize('site/media/type/ko-cosmicclash.png') ?? [56, 14];
  return `<div class="cosmic-clash" id="cosmic-clash" style="--w: ${mark[0]}; --h: ${mark[1]}; --kw: ${ko[0]}; --frames: ${COSMIC_FRAMES}">
  <a class="cc-card" href="play/" aria-label="Play COSMIC CLASH, the tournament of every titan: ${n} titans and growing">
    <span class="cc-kicker">A tournament mode</span>
    <span class="cc-mark"><img src="media/type/cosmicclash-sheet.png" width="${mark[0]}" height="${mark[1] * COSMIC_FRAMES}" alt="COSMIC CLASH" /></span>
    <img class="px ko" src="media/type/ko-cosmicclash.png" width="${ko[0]}" height="${ko[1]}" alt="우주 대결" lang="ko" />
    <span class="cc-badge" data-cosmic-count="${n}"><i aria-hidden="true"></i>${n} TITANS · GROWING</span>
    <span class="cc-text">Every titan in the game, dealt in a new order every run, with the Last One and the Mouth waiting at the top. When a new titan arrives, it joins the fight.</span>
    <span class="cc-more">Play it under TOURNAMENT →</span>
  </a>
</div>`;
}

export const ROSTER_BEGIN =
  '<!-- roster:begin (generated by tools/site/roster.ts from src/titans/roster.ts: edit the copy there) -->';
export const ROSTER_END = '<!-- roster:end -->';

/** The cards (and the boss teaser) for the whole roster, unformatted. */
export function rosterCards(): string {
  const sizes = readJson<Record<string, [number, number]>>(SIZES_JSON) ?? {};
  const counts = readJson<Record<string, number>>(MATTER_JSON) ?? {};
  const max = Math.max(1, ...SITE_ROSTER.map((r) => counts[r.site.file] ?? 0));
  const cards = SITE_ROSTER.map((r) =>
    card(
      r,
      sizes[r.site.file] ?? pngSize(`site/media/titans/${r.site.file}.png`) ?? [128, 128],
      counts[r.site.file],
      max,
    ),
  );
  return [...cards, mystery(SITE_ROSTER.length)].join('\n');
}

/** Replace the roster region (and the lede's titan count) in a landing page's HTML. Formatted with the repo's prettier. */
export async function injectRoster(html: string): Promise<string> {
  const a = html.indexOf(ROSTER_BEGIN);
  const b = html.indexOf(ROSTER_END);
  if (a < 0 || b < a)
    throw new Error('site roster: the roster:begin / roster:end markers are missing from the page');
  const n = SITE_ROSTER.length;
  let out = html.slice(0, a + ROSTER_BEGIN.length) + '\n' + rosterCards() + '\n' + html.slice(b);
  // the COSMIC CLASH banner: every shipped titan counts
  const ca = out.indexOf(COSMIC_BEGIN);
  const cb = out.indexOf(COSMIC_END);
  if (ca >= 0 && cb > ca)
    out = out.slice(0, ca + COSMIC_BEGIN.length) + '\n' + cosmicBanner(n) + '\n' + out.slice(cb);
  const counted = out.replace(
    /(<p class="lede">\s*)[A-Z][a-z]* colossi, [a-z]+ ways to destroy matter/,
    `$1${word(n)} colossi, ${word(n).toLowerCase()} ways to destroy matter`,
  );
  const config = JSON.parse(readFileSync('.prettierrc.json', 'utf8')) as Record<string, unknown>;
  return format(counted, { ...config, parser: 'html' });
}

/** Regenerate the cards of the page at `path` in place. */
export async function writeRosterInto(path: string): Promise<void> {
  writeFileSync(path, await injectRoster(readFileSync(path, 'utf8')));
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('tools/site/roster.ts')) {
  await writeRosterInto('site/index.html');
  console.log(`site/index.html: ${SITE_ROSTER.length} titan cards generated from the roster`);
}
