/**
 * 우리's packed asset (S4, Phase 2A): uri/data/uri_rig.json (the source of truth, never edited) converted at build time by
 * tools/matter/uribin.ts into
 *   - `uri_rig.meta.json`: every part's metadata, the draw order and the cores (a few KB, imported normally), and
 *   - `uri_rig.bin`: the per-cell grids, raw (no base64, no JSON parse), fetched once as a URL and viewed in place.
 *
 * Binary layout (little-endian): u32 magic 'URIB', u32 version, u32 part count, then for every part in the JSON's part order
 * and in field order mat, surf, tone, form, nx, ny, nz, edge (w×h bytes each) and chunk (w×h uint16): each field starts on a
 * 4-byte boundary. `tests`: src/titans/uri/asset.test.ts checks it is byte-identical to a fresh conversion of the JSON.
 *
 * Loading: the browser calls `loadUriAsset()` once at boot (src/main.ts). In Node (tests, tools) `uriGrids()` reads the file
 * synchronously on first use. Pure otherwise: no DOM, no static Node import.
 */
import meta from './uri_rig.meta.json';

export const URI_BIN_MAGIC = 0x42495255; // 'URIB'
export const URI_BIN_VERSION = 1;
export const URI_FIELDS = ['mat', 'surf', 'tone', 'form', 'nx', 'ny', 'nz', 'edge'] as const;
export type UriField = (typeof URI_FIELDS)[number];

/** The metadata part of the asset (uri_rig.json without its base64 grids). */
export interface UriMetaPart {
  name: string;
  label: string;
  kind: string;
  p?: number[];
  x0: number;
  y0: number;
  w: number;
  h: number;
  pivX: number;
  pivY: number;
  pg: number[];
  joints: { a?: number[]; b?: number[] };
  n: number;
  nchunk: number;
}
export interface UriMeta {
  parts: UriMetaPart[];
  order: string[];
  hot: number[];
  cold: number[];
  primIoU?: number;
}
export const URI_META = meta as unknown as UriMeta;

/** One part's grids, viewed in place in the binary. */
export type UriGrids = Record<UriField, Uint8Array> & { chunk: Uint16Array };

const align4 = (n: number): number => (n + 3) & ~3;

/** Byte size of the binary for `m` (header + every field, 4-byte aligned). */
export function uriBinSize(m: UriMeta): number {
  let o = 12;
  for (const p of m.parts) {
    const n = p.w * p.h;
    o += URI_FIELDS.length * align4(n) + align4(2 * n);
  }
  return o;
}

/** View the binary's grids (no copy). Throws on a wrong magic, version or size. */
export function decodeUriBinary(buf: ArrayBuffer, m: UriMeta = URI_META): UriGrids[] {
  const dv = new DataView(buf);
  if (buf.byteLength < 12 || dv.getUint32(0, true) !== URI_BIN_MAGIC)
    throw new Error('uri asset: not a URIB file');
  if (dv.getUint32(4, true) !== URI_BIN_VERSION)
    throw new Error('uri asset: wrong version (rebuild: tools/matter/uribin.ts)');
  if (dv.getUint32(8, true) !== m.parts.length || buf.byteLength !== uriBinSize(m))
    throw new Error('uri asset: does not match uri_rig.meta.json (rebuild: tools/matter/uribin.ts)');
  let o = 12;
  return m.parts.map((p) => {
    const n = p.w * p.h;
    const g = {} as UriGrids;
    for (const f of URI_FIELDS) {
      g[f] = new Uint8Array(buf, o, n);
      o += align4(n);
    }
    g.chunk = new Uint16Array(buf, o, n);
    o += align4(2 * n);
    return g;
  });
}

let grids: UriGrids[] | null = null;

/** Install the asset from its bytes (decoded once; later calls are ignored). */
export function setUriAsset(buf: ArrayBuffer): void {
  if (grids === null) grids = decodeUriBinary(buf);
}

/**
 * Browser boot: fetch and install the asset once (`url` = the Vite asset URL of uri_rig.bin, imported with `?url` by the
 * browser entry, src/main.ts). Resolves immediately when it is already installed.
 */
export async function loadUriAsset(url: string): Promise<void> {
  if (grids !== null) return;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`uri asset: ${res.status} fetching ${url}`);
  setUriAsset(await res.arrayBuffer());
}

/** Every part's grids (JSON part order). In Node the file is read synchronously on first use; in the browser call
 * `loadUriAsset()` first. */
export function uriGrids(): UriGrids[] {
  if (grids === null) {
    const proc = (
      globalThis as { process?: { getBuiltinModule?: (id: string) => unknown; cwd?: () => string } }
    ).process;
    const fs = proc?.getBuiltinModule?.('node:fs') as { readFileSync(p: string): Uint8Array } | undefined;
    if (!fs) throw new Error('uri asset: not loaded (call loadUriAsset() at boot)');
    // Node (tests, tools): run from the repository root
    const b = fs.readFileSync(`${proc!.cwd!()}/src/titans/uri/uri_rig.bin`);
    setUriAsset(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
  }
  return grids!;
}
