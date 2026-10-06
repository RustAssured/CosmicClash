// the metadata of uri/data/uri_rig.json (src/titans/uri/asset.ts; the grids are in uri_rig.bin, loaded separately)
import rigJson from './uri_rig.meta.json';

/**
 * 우리's rig (uri/docs/URI_SPEC.md §4; the oracle's `bodyTransforms` and frame placement in uri/src/20_kinetics.js).
 *
 * The rig carries only position and rotation. Every part is a pixel grid in its own local space (`uri/data/uri_rig.json`,
 * loaded as is) with a pivot (`pivX/pivY`, local) that sits at `pg` (reference coordinates, 403×368) in the rest pose. The
 * hierarchy, composed parent → child with 2-D transforms:
 *
 *   hips (pelvis centre)  ── pylons L/R (+ their own vectoring angle)
 *    └─ torso (chamber, pivot just above the pelvis) ── cores, loop, command-moon anchor
 *        ├─ dome L (pivot at its inner-lower edge, + slide dx) ── upper arm L (shoulder) ── forearm L (elbow) ── fist L (wrist)
 *        └─ dome R (same)                                     ── upper arm R            ── forearm R          ── fist R
 *
 * At rest every link is 0 and every transform is the identity: each part's pivot sits exactly at its `pg` and the layout is
 * the reference (spec §2.1). Pure and deterministic; no rendering here.
 */

export type UriPartKey =
  | 'pyL'
  | 'pyR'
  | 'pelvis'
  | 'uaL'
  | 'uaR'
  | 'domeL'
  | 'domeR'
  | 'chamber'
  | 'faL'
  | 'faR'
  | 'fistL'
  | 'fistR'
  | 'moon';

export type UriSide = 'L' | 'R';

/** A part's metadata (the pixel fields stay in the JSON; the loader decodes them). */
export interface UriPartMeta {
  key: UriPartKey;
  label: string;
  /** Primitive kind the part was fitted to ('ell' | 'cap'). */
  kind: string;
  /** Top-left of the part's grid in reference coordinates (integers) and its size. */
  x0: number;
  y0: number;
  w: number;
  h: number;
  /** Pivot in the part's local grid (fractional), and where it sits in reference coordinates at rest. */
  pivX: number;
  pivY: number;
  pgX: number;
  pgY: number;
  /** Bone ends in reference coordinates (arms and pylons): a = the joint it hangs from, b = the far end. */
  ja: readonly [number, number] | null;
  jb: readonly [number, number] | null;
  /** Number of pre-split chunks, and of matter cells. */
  nchunk: number;
  cells: number;
}

interface RawPart {
  name: string;
  label: string;
  kind: string;
  x0: number;
  y0: number;
  w: number;
  h: number;
  pivX: number;
  pivY: number;
  pg: number[];
  joints: { a?: number[]; b?: number[] };
  nchunk: number;
  n: number;
}

interface RawRig {
  parts: RawPart[];
  order: string[];
  hot: number[];
  cold: number[];
}

const RAW = rigJson as unknown as RawRig;

/** Reference space (the oracle's 403×368 sheet) and where the oracle draws its origin on the 640×360 screen. */
export const URI_REF = { w: 403, h: 368, originX: 200, originY: 170, screenX: 320, screenY: 186 } as const;

const pt = (p: number[] | undefined): readonly [number, number] | null =>
  p && p.length >= 2 ? ([p[0]!, p[1]!] as const) : null;

/** Every part, in the JSON's part order (index = part id in the asset). */
export const URI_PARTS: readonly UriPartMeta[] = RAW.parts.map((p) => ({
  key: p.name as UriPartKey,
  label: p.label,
  kind: p.kind,
  x0: p.x0,
  y0: p.y0,
  w: p.w,
  h: p.h,
  pivX: p.pivX,
  pivY: p.pivY,
  pgX: p.pg[0]!,
  pgY: p.pg[1]!,
  ja: pt(p.joints.a),
  jb: pt(p.joints.b),
  nchunk: p.nchunk,
  cells: p.n,
}));

/** Draw order, back → front (spec §4): pylons, pelvis, upper arms, domes, chamber (+ loop and cores), forearms, fists, moon. */
export const URI_ORDER: readonly UriPartKey[] = RAW.order as UriPartKey[];

/** The two world-cores in reference coordinates: [x, y, radius]. They never leave their cradles (spec §2.2). */
export const URI_HOT_CORE: readonly [number, number, number] = [RAW.hot[0]!, RAW.hot[1]!, RAW.hot[2]!];
export const URI_COLD_CORE: readonly [number, number, number] = [RAW.cold[0]!, RAW.cold[1]!, RAW.cold[2]!];

const BY_KEY = new Map<UriPartKey, UriPartMeta>(URI_PARTS.map((p) => [p.key, p]));
export const uriPart = (k: UriPartKey): UriPartMeta => {
  const p = BY_KEY.get(k);
  if (!p) throw new Error(`uri: part '${k}' missing from uri_rig.json`);
  return p;
};

/* ------------------------------------------------------------------------------------------------ *
 *  links (the degrees of freedom; spec §6.1). 2A holds them at rest; 2B's kinetic system drives them.
 * ------------------------------------------------------------------------------------------------ */

/** Link values: root (hx, hy px; ha rad), torso ta, arks (angle da rad, slide dx px), shoulder / elbow / wrist (rad), pylon vectoring (rad). */
export interface UriPose {
  hx: number;
  hy: number;
  ha: number;
  ta: number;
  daL: number;
  daR: number;
  dxL: number;
  dxR: number;
  sL: number;
  sR: number;
  eL: number;
  eR: number;
  wL: number;
  wR: number;
  pyL: number;
  pyR: number;
}

export const URI_LINKS: readonly (keyof UriPose)[] = [
  'hx',
  'hy',
  'ha',
  'ta',
  'daL',
  'daR',
  'dxL',
  'dxR',
  'sL',
  'sR',
  'eL',
  'eR',
  'wL',
  'wR',
  'pyL',
  'pyR',
];

export const restPose = (): UriPose => ({
  hx: 0,
  hy: 0,
  ha: 0,
  ta: 0,
  daL: 0,
  daR: 0,
  dxL: 0,
  dxR: 0,
  sL: 0,
  sR: 0,
  eL: 0,
  eR: 0,
  wL: 0,
  wR: 0,
  pyL: 0,
  pyR: 0,
});

/* ------------------------------------------------------------------------------------------------ *
 *  2-D transforms (the oracle's ap / about / cmp / tr)
 * ------------------------------------------------------------------------------------------------ */

/** A rigid 2-D transform: rotate by `a`, then translate by (x, y). */
export interface Xf {
  a: number;
  x: number;
  y: number;
}

/** Apply a transform to a point. */
export function apply(T: Xf, px: number, py: number, out: { x: number; y: number }): void {
  const c = Math.cos(T.a);
  const s = Math.sin(T.a);
  out.x = px * c - py * s + T.x;
  out.y = px * s + py * c + T.y;
}

/** Rotation by `a` about the point (cx, cy). */
export function about(cx: number, cy: number, a: number): Xf {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return { a, x: cx - (cx * c - cy * s), y: cy - (cx * s + cy * c) };
}

/** A ∘ B (apply B first, then A). */
export function compose(A: Xf, B: Xf): Xf {
  const c = Math.cos(A.a);
  const s = Math.sin(A.a);
  return { a: A.a + B.a, x: B.x * c - B.y * s + A.x, y: B.x * s + B.y * c + A.y };
}

export const translate = (dx: number, dy: number): Xf => ({ a: 0, x: dx, y: dy });

/* ------------------------------------------------------------------------------------------------ *
 *  the hierarchy
 * ------------------------------------------------------------------------------------------------ */

/** Hip centre and torso pivot in reference coordinates (the oracle: the pelvis pivot, and the chamber's x 14 px above it). */
export const hipCentre = (): readonly [number, number] => [uriPart('pelvis').pgX, uriPart('pelvis').pgY];
export const torsoCentre = (): readonly [number, number] => [
  uriPart('chamber').pgX,
  uriPart('pelvis').pgY - 14,
];
/** An ark's pivot: its inner-lower edge (30 px toward the body, 22 px down from its centre). */
export const domePivot = (s: UriSide): readonly [number, number] => {
  const d = uriPart(s === 'L' ? 'domeL' : 'domeR');
  return [d.pgX + (s === 'L' ? 1 : -1) * 30, d.pgY + 22];
};

/** The body transforms: hips, torso, and each ark (spec §4). */
export interface UriBodyXf {
  hip: Xf;
  torso: Xf;
  domeL: Xf;
  domeR: Xf;
}

export function bodyTransforms(p: UriPose): UriBodyXf {
  const [hx, hy] = hipCentre();
  const [tx, ty] = torsoCentre();
  const hip = compose(translate(p.hx, p.hy), about(hx, hy, p.ha));
  const torso = compose(hip, about(tx, ty, p.ta));
  const dome = (s: UriSide): Xf => {
    const [cx, cy] = domePivot(s);
    return compose(
      torso,
      compose(translate(s === 'L' ? p.dxL : p.dxR, 0), about(cx, cy, s === 'L' ? p.daL : p.daR)),
    );
  };
  return { hip, torso, domeL: dome('L'), domeR: dome('R') };
}

/** Where a part is: its pivot in reference coordinates and its angle (rad, + clockwise in the y-down frame). */
export interface PartPlace {
  x: number;
  y: number;
  a: number;
}

export type UriPlaces = Record<UriPartKey, PartPlace>;

export const emptyPlaces = (): UriPlaces => {
  const o = {} as UriPlaces;
  for (const p of URI_PARTS) o[p.key] = { x: p.pgX, y: p.pgY, a: 0 };
  return o;
};

/** The arm chain transforms for one side (shoulder, elbow, wrist), composed onto the ark's transform. */
export function armTransforms(s: UriSide, dome: Xf, p: UriPose): { sh: Xf; el: Xf; wr: Xf } {
  const ua = uriPart(s === 'L' ? 'uaL' : 'uaR');
  const fa = uriPart(s === 'L' ? 'faL' : 'faR');
  const sa = ua.ja!;
  const eb = ua.jb!;
  const wb = fa.jb!;
  const sh = compose(dome, about(sa[0], sa[1], s === 'L' ? p.sL : p.sR));
  const el = compose(sh, about(eb[0], eb[1], s === 'L' ? p.eL : p.eR));
  const wr = compose(el, about(wb[0], wb[1], s === 'L' ? p.wL : p.wR));
  return { sh, el, wr };
}

const tmp = { x: 0, y: 0 };

/**
 * Place every part for a pose (reference coordinates), the oracle's frame placement: the pelvis and pylons ride the hips
 * (a pylon adds its own vectoring angle), chamber and moon anchor the torso, the domes their ark transforms, the arm parts
 * their chain. The command moon is placed at its anchor here; 2B tethers it by gravity instead (spec §6.6).
 */
export function placeParts(p: UriPose, out: UriPlaces): UriPlaces {
  const B = bodyTransforms(p);
  const put = (k: UriPartKey, T: Xf, extra = 0): void => {
    const m = uriPart(k);
    apply(T, m.pgX, m.pgY, tmp);
    const o = out[k];
    o.x = tmp.x;
    o.y = tmp.y;
    o.a = T.a + extra;
  };
  put('pelvis', B.hip);
  put('pyL', B.hip, p.pyL);
  put('pyR', B.hip, p.pyR);
  put('chamber', B.torso);
  put('moon', B.torso);
  put('domeL', B.domeL);
  put('domeR', B.domeR);
  for (const s of ['L', 'R'] as const) {
    const A = armTransforms(s, s === 'L' ? B.domeL : B.domeR, p);
    put(s === 'L' ? 'uaL' : 'uaR', A.sh);
    put(s === 'L' ? 'faL' : 'faR', A.el);
    put(s === 'L' ? 'fistL' : 'fistR', A.wr);
  }
  return out;
}

/** The world-cores' positions for a pose: they ride the torso (and never leave their cradles). */
export function corePositions(
  p: UriPose,
  hot: { x: number; y: number },
  cold: { x: number; y: number },
): void {
  const B = bodyTransforms(p);
  apply(B.torso, URI_HOT_CORE[0], URI_HOT_CORE[1], hot);
  apply(B.torso, URI_COLD_CORE[0], URI_COLD_CORE[1], cold);
}
