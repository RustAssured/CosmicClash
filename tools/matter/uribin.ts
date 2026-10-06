/**
 * Build step for 우리's packed asset (src/titans/uri/asset.ts): uri/data/uri_rig.json (the source of truth) →
 * src/titans/uri/uri_rig.meta.json (metadata) + src/titans/uri/uri_rig.bin (raw grids). Run after any change to the JSON:
 *   npx tsx tools/matter/uribin.ts
 * src/titans/uri/asset.test.ts fails when the committed files are not a fresh conversion.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { URI_BIN_MAGIC, URI_BIN_VERSION, URI_FIELDS, uriBinSize, type UriMeta } from '@/titans/uri/asset';

type RawPart = Record<string, unknown> & { w: number; h: number };

/** Convert the rig JSON text into the metadata object and the binary bytes. */
export function buildUriAsset(jsonText: string): { meta: UriMeta; bin: Uint8Array } {
  const raw = JSON.parse(jsonText) as {
    parts: RawPart[];
    order: string[];
    hot: number[];
    cold: number[];
    primIoU?: number;
  };
  const grid = new Set<string>([...URI_FIELDS, 'chunk']);
  const meta: UriMeta = {
    parts: raw.parts.map((p) =>
      Object.fromEntries(Object.entries(p).filter(([k]) => !grid.has(k))),
    ) as unknown as UriMeta['parts'],
    order: raw.order,
    hot: raw.hot,
    cold: raw.cold,
    primIoU: raw.primIoU,
  };
  const bin = new Uint8Array(uriBinSize(meta));
  const dv = new DataView(bin.buffer);
  dv.setUint32(0, URI_BIN_MAGIC, true);
  dv.setUint32(4, URI_BIN_VERSION, true);
  dv.setUint32(8, raw.parts.length, true);
  let o = 12;
  for (const p of raw.parts) {
    const n = p.w * p.h;
    for (const f of [...URI_FIELDS, 'chunk']) {
      const bytes = Buffer.from(p[f] as string, 'base64');
      const want = f === 'chunk' ? 2 * n : n;
      if (bytes.length !== want)
        throw new Error(`uribin: ${String(p.name)}.${f} has ${bytes.length} bytes, want ${want}`);
      bin.set(bytes, o);
      o += (want + 3) & ~3;
    }
  }
  if (o !== bin.length) throw new Error('uribin: size mismatch');
  return { meta, bin };
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('tools/matter/uribin.ts')) {
  const root = process.cwd();
  const { meta, bin } = buildUriAsset(readFileSync(join(root, 'uri/data/uri_rig.json'), 'utf8'));
  writeFileSync(join(root, 'src/titans/uri/uri_rig.meta.json'), `${JSON.stringify(meta, null, 1)}\n`);
  writeFileSync(join(root, 'src/titans/uri/uri_rig.bin'), bin);
  console.log(
    `wrote src/titans/uri/uri_rig.bin (${bin.length} bytes) and uri_rig.meta.json (${meta.parts.length} parts)`,
  );
}
