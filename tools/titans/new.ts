/**
 * THE TITAN KIT'S SCAFFOLD: make a new titan, registered everywhere, as a plain placeholder creature that compiles, can be
 * picked in VS AI and Training, and passes the roster checks straight away. Then make it yours (docs/TITAN_GUIDE.md).
 *
 *   npm run new:titan -- <id> "<English Name>" "<Korean name>" [options]
 *   npm run new:titan -- --remove <id>
 *
 * Options:
 *   --from=blob        the minimal blob creature (default): its own painter (src/titans/kit/blob.ts) and moves
 *   --from=<titan>     start from an existing titan (planet, asteroid, nexus, blackhole, supernova, lastone): its painter,
 *                      behaviour, moves and numbers, recoloured; its move ids keep the template's prefix (its behaviour
 *                      keys on them)
 *   --size=small|medium|large   the size class (default medium; blob only: the body is scaled to it)
 *   --hue=<0..359>     the palette's hue (default: the hue farthest from every other titan's colours)
 *   --stage=<stage>    its home stage (default rim)
 *   --essence=<word>   the one idea it is, for its card (default "mystery")
 *   --no-art           skip the site portrait / Korean name / matter count
 *
 * It writes:
 *   src/titans/kit/<id>/<id>.json        definition: attributes, moves (frame data in ticks), materials and palette, art
 *                                        params, AI weights, voice tuning, site card copy (the `kit` block)
 *   src/titans/kit/<id>/index.ts         its painter and rig (the template's)
 *   src/combat/behaviours/kit/<id>.ts    its behaviour: one signature-mechanic hook to fill in
 * and registers it in src/contracts/roster.ts, src/titans/kit/index.ts and src/combat/behaviours/kit/index.ts (at the
 * `new:titan` markers), then draws its site art (tools/site/art.ts), counts its matter and regenerates the site's cards.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import {
  ROSTER_IDS,
  SIZE_CLASSES,
  type MaterialSpec,
  type MoveDef,
  type SizeClass,
  type TitanDef,
  type TitanId,
} from '@/contracts';
import { getTitanDef } from '@/titans/defs';
import { ROSTER } from '@/titans/roster';
import { buildRamp, hexToHsl, hslToHex, hueDistance, rotateHue } from '@/titans/kit/palette';

const args = process.argv.slice(2);
const opt = (k: string, d = ''): string =>
  args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const flag = (k: string): boolean => args.includes(`--${k}`);
const positional = args.filter((a) => !a.startsWith('--'));

const REGISTRY = {
  roster: 'src/contracts/roster.ts',
  titans: 'src/titans/kit/index.ts',
  behaviours: 'src/combat/behaviours/kit/index.ts',
};

/** Templates that are existing titans: their painter, rig builder and behaviour class. */
const TEMPLATES: Record<
  string,
  { art: string; paint: string; rig: string; behaviour: string; file: string }
> = {
  planet: {
    art: 'planet',
    paint: 'paintPlanet',
    rig: 'buildPlanetRig',
    behaviour: 'PlanetBehaviour',
    file: 'planet',
  },
  asteroid: {
    art: 'asteroid',
    paint: 'paintAsteroid',
    rig: 'buildAsteroidRig',
    behaviour: 'AsteroidBehaviour',
    file: 'asteroid',
  },
  nexus: {
    art: 'nexus',
    paint: 'paintNexus',
    rig: 'buildNexusRig',
    behaviour: 'NexusBehaviour',
    file: 'nexus',
  },
  blackhole: {
    art: 'blackhole',
    paint: 'paintBlackHole',
    rig: 'buildBlackHoleRig',
    behaviour: 'BlackHoleBehaviour',
    file: 'blackhole',
  },
  supernova: {
    art: 'supernova',
    paint: 'paintSupernova',
    rig: 'buildSupernovaRig',
    behaviour: 'SupernovaBehaviour',
    file: 'supernova',
  },
  lastone: {
    art: 'lastone',
    paint: 'paintLastOne',
    rig: 'buildLastOneRig',
    behaviour: 'LastOneBehaviour',
    file: 'lastone',
  },
};

const pascal = (id: string): string => id.charAt(0).toUpperCase() + id.slice(1);
const run = (cmd: string, a: string[]): void => {
  // one command line through the shell (npx is a .cmd on Windows); every argument here is a path or a --flag=id
  const line = [cmd, ...a.map((x) => `"${x}"`)].join(' ');
  const r = spawnSync(line, { stdio: 'inherit', shell: true });
  if (r.status !== 0) throw new Error(`${cmd} ${a.join(' ')} failed`);
};
const read = (p: string): string => readFileSync(p, 'utf8');

/* ------------------------------------------------------------------------------------------------ registration */

const MARK = '// new:titan';
/** The site's per-titan numbers (portrait sizes, matter counts), kept in the repo's prettier format. */
const SITE_JSON = ['site/media/titans/sizes.json', 'site/media/titans/matter.json'];

/** Insert `line` right above the first line holding `marker` (keeping its indentation). */
function insertAbove(path: string, marker: string, line: string): void {
  const src = read(path);
  const at = src.indexOf(marker);
  if (at < 0) throw new Error(`${path}: marker '${marker}' not found`);
  const lineStart = src.lastIndexOf('\n', at) + 1;
  const indent = src.slice(lineStart, at);
  writeFileSync(path, src.slice(0, lineStart) + indent + line + '\n' + src.slice(lineStart));
}

function register(id: string, name: string): void {
  insertAbove(REGISTRY.roster, `${MARK} (the scaffold adds new ids`, `'${id}',`);
  insertAbove(REGISTRY.titans, `${MARK} imports`, `import ${id}Kit from './${id}';`);
  insertAbove(REGISTRY.titans, `${MARK} (the scaffold adds entries`, `${id}Kit,`);
  insertAbove(REGISTRY.behaviours, `${MARK} imports`, `import { ${name}Behaviour } from './${id}';`);
  insertAbove(
    REGISTRY.behaviours,
    `${MARK} (the scaffold adds entries`,
    `${id}: (f) => new ${name}Behaviour(f),`,
  );
}

/** Drop every registry line that names the titan (the lines `register` added). */
function unregister(id: string, name: string): void {
  const kill: Record<string, RegExp[]> = {
    [REGISTRY.roster]: [new RegExp(`^\\s*'${id}',\\s*$`)],
    [REGISTRY.titans]: [new RegExp(`^import ${id}Kit from './${id}';$`), new RegExp(`^\\s*${id}Kit,\\s*$`)],
    [REGISTRY.behaviours]: [
      new RegExp(`^import \\{ ${name}Behaviour \\} from './${id}';$`),
      new RegExp(`^\\s*${id}: \\(f\\) => new ${name}Behaviour\\(f\\),\\s*$`),
    ],
  };
  for (const [path, res] of Object.entries(kill)) {
    const lines = read(path).split('\n');
    writeFileSync(path, lines.filter((l) => !res.some((r) => r.test(l))).join('\n'));
  }
}

/* ------------------------------------------------------------------------------------------------ the definition */

const SIZE_SCALE: Record<SizeClass, number> = { small: 0.72, medium: 1, large: 1.3, huge: 1.3 };

/** The hue farthest from every roster titan's signature colours (accent and accent2, weighted by how colourful they are). */
function freeHue(): number {
  const used = ROSTER.flatMap((r) => [r.site.accent, r.site.accent2]).map(hexToHsl);
  let best = 0;
  let bestScore = -1;
  for (let h = 0; h < 360; h += 5) {
    let score = 180;
    for (const [uh, us] of used) score = Math.min(score, hueDistance(h, uh) + (1 - us) * 60);
    if (score > bestScore) {
      bestScore = score;
      best = h;
    }
  }
  return best;
}

const mat = (
  key: string,
  base: string,
  ramp: string[],
  emissive: number,
  extra: Partial<MaterialSpec> = {},
): MaterialSpec =>
  ({
    key,
    base,
    visual: { ramp, emissive, char: ramp[1], crack: ramp[0], debris: ramp[Math.floor(ramp.length / 2)] },
    ...extra,
  }) as unknown as MaterialSpec;

/** Scale every hitbox's geometry (offsets, radii, ranges, widths) of a move by k. */
function scaleMove(m: MoveDef, k: number): MoveDef {
  const s = JSON.parse(JSON.stringify(m)) as MoveDef;
  const keys = ['ox', 'oy', 'r', 'r0', 'r1', 'range', 'ox0', 'oy0', 'ox1', 'oy1', 'width'];
  for (const v of Object.values(s.variants))
    for (const hb of v.hitboxes)
      for (const shape of [hb.shape, hb.sweepTo])
        if (shape)
          for (const key of keys) {
            const o = shape as unknown as Record<string, number>;
            if (typeof o[key] === 'number') o[key] = Math.round(o[key] * k * 10) / 10;
          }
  return s;
}

/**
 * The blob creature: a medium, balanced brawler with KINETIC blows, built on the Asteroid's proven frame data (the feel
 * targets and the AI model hold) without any of its parts (no swarm, no cascade, no tumble spin).
 */
function blobDef(id: string, name: string, ko: string, hue: number, size: SizeClass): TitanDef {
  const k = SIZE_SCALE[size];
  const ast = getTitanDef('asteroid');
  const reach = 1.25 * k;
  const pick = (slot: string): MoveDef => {
    const m = ast.moves.find((x) => x.slot === slot)!;
    return scaleMove(m, reach);
  };
  const strike = pick('strike');
  const crush = pick('crush');
  const surge = pick('surge');
  const sig = pick('signature');
  const ult = pick('ultimate');
  const guard = pick('guard');
  const moves: MoveDef[] = [
    {
      ...strike,
      id: `${id}.slam`,
      name: 'Slam',
      nameKo: '강타',
      tags: [],
      extra: { pose: strike.extra!['pose'] },
    },
    {
      ...crush,
      id: `${id}.engulf`,
      name: 'Engulf',
      nameKo: '삼키기',
      tags: ['heavy'],
      extra: { pose: crush.extra!['pose'] },
    },
    { ...surge, id: `${id}.slither`, name: 'Slither', nameKo: '미끄러짐', tags: ['dash'], extra: {} },
    {
      ...sig,
      id: `${id}.swell`,
      name: 'Swell',
      nameKo: '부풀기',
      frame: { ...sig.frame, startup: 16, active: 12, recovery: 24 },
      tags: ['burst'],
      resourceCost: 0,
      extra: { pose: { startup: { lean: -4 }, active: { lean: 2 } }, weight: 'medium' },
      variants: Object.fromEntries(
        Object.entries(sig.variants).map(([aim, v]) => [
          aim,
          {
            ...v,
            hitboxes: v.hitboxes.map((hb) => ({
              ...hb,
              id: 'swell',
              from: 0,
              to: 6,
              damage: { ...hb.damage, energy: 380 },
              knockback: { x: 260, y: -40 },
              guardPressure: 0.45,
            })),
          },
        ]),
      ) as MoveDef['variants'],
    },
    {
      ...ult,
      id: `${id}.bloom`,
      name: 'Bloom',
      nameKo: '만개',
      tags: ['ultimate', 'armor'],
      extra: { pose: ult.extra!['pose'] },
    },
    { ...guard, id: `${id}.guard`, name: 'Hide', nameKo: '움츠리기' },
  ];

  const ramp = (dh: number, n: number, sat: number, lo: number, hi: number): string[] =>
    buildRamp(hue + dh, n, sat, lo, hi);
  const materials = [
    mat('skin', 'regolith', ramp(0, 8, 0.45, 0.07, 0.82), 0, {
      physics: { toughness: 0.95 },
    } as Partial<MaterialSpec>),
    mat('flesh', 'regolith', ramp(-12, 7, 0.55, 0.1, 0.78), 0),
    mat('marking', 'crystal', ramp(150, 6, 0.65, 0.12, 0.85), 20),
    mat('eye', 'crystal', ramp(180, 6, 0.75, 0.1, 0.92), 48),
    mat('core', 'ironNickel', ramp(170, 6, 0.85, 0.2, 0.95), 60, {
      physics: { density: 3, toughness: 0.9 },
    } as Partial<MaterialSpec>),
  ];
  const r = (v: number): number => Math.round(v * k);
  const W = r(176);
  const H = r(164);
  const accent = hslToHex(hue, 0.62, 0.6);
  const accent2 = hslToHex(hue + 180, 0.7, 0.7);
  return {
    id: id as TitanId,
    name,
    nameKo: ko,
    epithet: 'The Newcomer',
    attributes: { mass: 5, cohesion: 5, heat: 5, gravity: 4, reach: 5, tempo: 6 },
    resource: { id: 'fragments', name: 'Lobes', nameKo: '혹', max: 5, start: 5, display: 'pips' },
    destruction: 'KINETIC',
    passive: {
      name: 'Swell',
      text: 'Its signature move swells it: for two seconds every blow it lands hits harder.',
    },
    failureMode: {
      name: 'Deflate',
      text: 'Below about a third of its mass it sags: slower, and easier to tear.',
    },
    materials,
    art: {
      w: W,
      h: H,
      coreX: r(82),
      coreY: r(86),
      coreRadius: r(10),
      params: {
        centre: [r(88), r(82)],
        body: { rx: r(58), ry: r(52) },
        lobes: 5,
        lobeSize: 0.38,
        wobble: 6 * k,
        skin: 4,
        markingSize: 13 * k,
        markings: 0.35,
        eyes: 3,
        eyeR: 7 * k,
        core: { x: r(-6), y: r(4), r: r(10) },
      },
    },
    moves,
    ai: {
      style: 'A plain brawler: walks in, slams, swells before it engulfs.',
      weights: {
        aggression: 0.6,
        patience: 0.3,
        zoning: 0.25,
        retreat: 0.4,
        trap: 0.1,
        punish: 0.65,
        gaze: 0,
      },
    },
    ui: { accent, accent2, tagline: 'Something new crawled in from the dark.' },
    feel: {
      bob: { amp: 0.7, period: 2.6 },
      sway: { amp: 0.4, period: 3.4 },
      fx: {
        kind: 'dust',
        ramp: [hslToHex(hue, 0.3, 0.65), hslToHex(hue, 0.3, 0.42), hslToHex(hue, 0.25, 0.22)],
        perHundredPx: 7,
        size: 1,
        life: [14, 30],
        spread: 30,
        behind: 24,
        rise: 10,
      },
    },
  } as unknown as TitanDef;
}

/** Recolour every '#rrggbb' string in a JSON value by rotating its hue. */
function recolour<T>(v: T, deg: number): T {
  return JSON.parse(
    JSON.stringify(v).replace(/"#([0-9a-fA-F]{6})"/g, (_, h: string) => `"${rotateHue(`#${h}`, deg)}"`),
  ) as T;
}

function fromTemplate(tpl: string, id: string, name: string, ko: string, hue: number): TitanDef {
  const base = JSON.parse(read(`src/titans/${TEMPLATES[tpl]!.file}.json`)) as TitanDef;
  const deg = hue - hexToHsl(base.ui.accent)[0];
  const def = recolour(base, deg);
  def.id = id as TitanId;
  def.name = name;
  def.nameKo = ko;
  // the Planet's Tidal Draw: its AI only uses it when the weight says so (src/ai/controller.ts reads 'draw')
  if (tpl === 'planet') def.ai.weights['draw'] ??= 1;
  return def;
}

/* ------------------------------------------------------------------------------------------------ the files */

function indexTs(id: string, tpl: string): string {
  if (tpl === 'blob')
    return `import type { TitanDef } from '@/contracts';
import { buildBlobRig, paintBlob } from '../blob';
import type { KitTitan } from '../types';
import json from './${id}.json';

/**
 * ${id}: a titan made with the titan kit from the blob template. Its look is the blob painter (src/titans/kit/blob.ts) driven
 * by the JSON's art.params and material ramps; write its own painter here when it outgrows the blob (docs/TITAN_GUIDE.md).
 */
const def = json as unknown as TitanDef;
const kit: KitTitan = { def, paint: paintBlob, rig: buildBlobRig };
export default kit;
`;
  const t = TEMPLATES[tpl]!;
  return `import type { TitanDef } from '@/contracts';
import { ${t.paint}, ${t.rig} } from '../../art/${t.art}';
import type { PaintedTitan } from '../../generate';
import type { KitTitan } from '../types';
import json from './${id}.json';

/** ${id}: a titan made with the titan kit from the ${tpl} template (its painter and rig, recoloured by its JSON). */
const def = json as unknown as TitanDef;
const kit: KitTitan = {
  def,
  paint: ${t.paint} as (d: TitanDef, s: number, l: Parameters<typeof ${t.paint}>[2]) => PaintedTitan,
  rig: ${t.rig},
};
export default kit;
`;
}

function behaviourTs(id: string, name: string, tpl: string): string {
  if (tpl === 'blob')
    return `import type { EffectiveStats } from '@/contracts';
import type { ActiveMove } from '../../move';
import { KitBehaviour } from './base';

/**
 * ${name}'s behaviour (titan kit, blob template). ONE signature mechanic hook: \`onSignature\` runs when its signature move
 * (${id}.swell) goes active. The placeholder: it swells for two seconds and every blow it lands hits 20 % harder.
 *
 * Replace it with the creature's own idea (docs/TITAN_GUIDE.md, "The signature move"). Keep the sim deterministic: state in
 * fields, changed only in these hooks, folded into \`hashState\`.
 */
export class ${name}Behaviour extends KitBehaviour {
  protected override onSignature(_m: ActiveMove): void {
    this.signatureLeft = 120; // ticks (60 = one second)
  }

  protected override signatureStats(s: EffectiveStats): void {
    s.damageMul *= 1.2;
  }
}
`;
  const t = TEMPLATES[tpl]!;
  return `import { ${t.behaviour} } from '../${tpl}';

/**
 * ${name}'s behaviour (titan kit, ${tpl} template): the template's own behaviour, unchanged. Override its hooks here to give
 * it its own signature mechanic (see src/combat/behaviour.ts for every hook, and KitBehaviour in ./base.ts).
 */
export class ${name}Behaviour extends ${t.behaviour} {}
`;
}

/* ------------------------------------------------------------------------------------------------ main */

if (flag('remove') || opt('remove')) {
  const id = opt('remove') || positional[0];
  if (!id) throw new Error('usage: npm run new:titan -- --remove <id>');
  const name = pascal(id);
  unregister(id, name);
  rmSync(`src/titans/kit/${id}`, { recursive: true, force: true });
  rmSync(`src/combat/behaviours/kit/${id}.ts`, { force: true });
  for (const f of [`site/media/titans/${id}.png`, `site/media/type/ko-${id}.png`]) rmSync(f, { force: true });
  for (const j of SITE_JSON)
    if (existsSync(j)) {
      const o = JSON.parse(read(j)) as Record<string, unknown>;
      delete o[id];
      writeFileSync(j, JSON.stringify(o, null, 2) + '\n');
    }
  run('npx', ['tsx', 'tools/site/roster.ts']);
  run('npx', ['prettier', '--write', ...Object.values(REGISTRY), ...SITE_JSON]);
  console.log(`\nremoved '${id}' from the roster and deleted its files.`);
  process.exit(0);
}

const [id, name, ko] = positional;
if (!id || !name || !ko)
  throw new Error(
    'usage: npm run new:titan -- <id> "<English Name>" "<Korean name>" [--from=blob|planet|…] [--size=…]',
  );
if (!/^[a-z][a-z0-9]{2,15}$/.test(id))
  throw new Error(`id '${id}': 3–16 lowercase letters/digits, starting with a letter`);
if ((ROSTER_IDS as readonly string[]).includes(id) || id === 'mouth' || existsSync(`src/titans/kit/${id}`))
  throw new Error(`'${id}' is already a titan`);
const tpl = opt('from', 'blob');
if (tpl !== 'blob' && !TEMPLATES[tpl])
  throw new Error(`--from=${tpl}: use blob or one of ${Object.keys(TEMPLATES).join(', ')}`);
const size = opt('size', tpl === 'planet' || tpl === 'asteroid' ? 'small' : 'medium') as SizeClass;
if (!SIZE_CLASSES[size]) throw new Error(`--size=${size}: use ${Object.keys(SIZE_CLASSES).join(', ')}`);
const hue = opt('hue') ? +opt('hue') : freeHue();
const cls = pascal(id);

const def = tpl === 'blob' ? blobDef(id, name, ko, hue, size) : fromTemplate(tpl, id, name, ko, hue);
def.kit = {
  template: tpl,
  size,
  stage: opt('stage', 'rim'),
  light: { c: hexRgb(def.ui.accent), radius: 110, base: 0.22 },
  voice: { pitch: 55, grit: 0.5, ring: 0.3, wet: 0.5 },
  site: {
    file: id,
    essence: opt('essence', 'mystery'),
    name,
    ko,
    lore: `${name} is new here. Nobody has written its story yet.`,
    mech: { title: `${def.passive.name}.`, text: def.passive.text },
    accent: def.ui.accent,
    accent2: def.ui.accent2,
    portrait: size === 'small' ? 'x2' : 'x1',
    clip: false,
  },
  homage: '',
  // every new titan starts as work in progress: off the menus, site and press until WJ ships it (delete this line then)
  wip: true,
};

function hexRgb(h: string): [number, number, number] {
  const v = parseInt(h.slice(1), 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255].map(
    (x) => Math.round(x * 100) / 100,
  ) as [number, number, number];
}

mkdirSync(`src/titans/kit/${id}`, { recursive: true });
const files = [
  `src/titans/kit/${id}/${id}.json`,
  `src/titans/kit/${id}/index.ts`,
  `src/combat/behaviours/kit/${id}.ts`,
];
writeFileSync(files[0]!, JSON.stringify(def, null, 2) + '\n');
writeFileSync(files[1]!, indexTs(id, tpl));
writeFileSync(files[2]!, behaviourTs(id, cls, tpl));
register(id, cls);
run('npx', ['prettier', '--write', ...files, ...Object.values(REGISTRY)]);
console.log(`\n'${id}' (${name}, ${ko}) scaffolded from '${tpl}' at hue ${hue}°, size ${size}.`);

if (!flag('no-art')) {
  // a fresh process: it imports the roster with the new titan registered
  run('npx', ['tsx', 'tools/site/art.ts', `--only=${id}`]);
  run('npx', ['tsx', 'tools/site/matter.ts', `--only=${id}`]);
  run('npx', ['prettier', '--write', ...SITE_JSON]);
}
console.log(`
Next:
  npx tsc --noEmit && npx vitest run src/titans      the roster checks (size, palette, AI coverage, replay)
  npm run titan:check -- ${id}                         the balance sweep and a report
  npm run dev, then ?mode=training&a=${id}&b=planet     play it (or ?a=${id}&b=planet&p1=human&p2=ai for VS AI)
  ?wip=${id}                                            shows it in the menus (it is work in progress: kit.wip)
  edit src/titans/kit/${id}/${id}.json                  its numbers, palette, card copy (docs/TITAN_GUIDE.md)
  npm run new:titan -- --remove ${id}                  take it out again`);
