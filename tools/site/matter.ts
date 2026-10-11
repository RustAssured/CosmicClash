/**
 * The roster cards' MATTER stat: how many cells of simulated matter each titan's body really has, counted from the game's
 * own generators (generateTitanBody at seed 1 and default lighting; every region of the Witness; every part of 우리 at
 * URI_SCALE, its game size). The numbers are written into site/index.html, into each `<span class="titan-matter"
 * data-titan="…">`, so the page needs no code to show them.
 *
 *   npx tsx tools/site/matter.ts          # count, print, and update site/index.html
 *
 * Re-run when a titan's art or size changes.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { DEFAULT_LIGHTING, type MatterMap, type TitanId } from '@/contracts';
import { generateTitanBody, getTitanDef, type UriTitanRig, type WitnessTitanRig } from '@/titans';

const cells = (m: MatterMap): number => {
  let n = 0;
  for (let i = 0; i < m.material.length; i++) if (m.material[i] !== 0) n++;
  return n;
};

// D36: card 'lastone' is the colossus ('colossus', every region counted); card 'witness' is the tendril titan ('lastone')
const ROSTER: { card: string; id: TitanId; witness?: boolean }[] = [
  { card: 'lastone', id: 'colossus', witness: true },
  { card: 'witness', id: 'lastone' },
  { card: 'planet', id: 'planet' },
  { card: 'asteroid', id: 'asteroid' },
  { card: 'nexus', id: 'nexus' },
  { card: 'blackhole', id: 'blackhole' },
  { card: 'supernova', id: 'supernova' },
  { card: 'uri', id: 'uri' },
];

const counts: Record<string, number> = {};
for (const t of ROSTER) {
  const def = getTitanDef(t.id);
  const body = generateTitanBody(def, 1, DEFAULT_LIGHTING);
  let n: number;
  if (t.witness) n = (body.rig as WitnessTitanRig).body.regions.reduce((s, r) => s + cells(r.map), 0);
  else if (t.id === 'uri') n = (body.rig as UriTitanRig).parts.reduce((s, p) => s + cells(p.map), 0);
  else n = cells(body.map);
  counts[t.card] = n;
  console.log(`${t.card.padEnd(10)} ${n.toLocaleString('en-US').padStart(8)} cells`);
}

const PAGE = 'site/index.html';
let html = readFileSync(PAGE, 'utf8');
let hits = 0;
// --m: the share of the heaviest titan's matter, for the card's little mass bar
const max = Math.max(...Object.values(counts));
html = html.replace(
  /<span class="titan-matter" data-titan="([a-z]+)"[^>]*>[\s\S]*?<\/span>/g,
  (all, card: string) => {
    const n = counts[card];
    if (n == null) return all;
    hits++;
    const m = (n / max).toFixed(3);
    return `<span class="titan-matter" data-titan="${card}" style="--m: ${m}"><b>MATTER</b> ${n.toLocaleString('en-US')} px</span>`;
  },
);
writeFileSync(PAGE, html);
console.log(`site/index.html: ${hits} cards updated`);
