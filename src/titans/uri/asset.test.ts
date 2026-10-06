import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildUriAsset } from '../../../tools/matter/uribin';
import { URI_META, decodeUriBinary, uriGrids } from './asset';
import { decodeJsonPart, uriPartMatter, uriPartMatterFrom, type RawFields } from './maps';

/**
 * The packed 우리 asset (uri_rig.bin + uri_rig.meta.json) is a faithful, up-to-date conversion of uri/data/uri_rig.json (the
 * source of truth), and decodes to the very same matter maps as the JSON's base64 grids.
 */
const root = process.cwd();
const jsonText = readFileSync(join(root, 'uri/data/uri_rig.json'), 'utf8');

describe('uri_rig.bin', () => {
  it('is byte-identical to a fresh conversion of uri_rig.json (rebuild with tools/matter/uribin.ts)', () => {
    const fresh = buildUriAsset(jsonText);
    const bin = readFileSync(join(root, 'src/titans/uri/uri_rig.bin'));
    expect(bin.length).toBe(fresh.bin.length);
    expect(Buffer.compare(bin, Buffer.from(fresh.bin))).toBe(0);
    expect(JSON.parse(JSON.stringify(URI_META))).toEqual(JSON.parse(JSON.stringify(fresh.meta)));
  });

  it('decodes to the same grids and the same matter maps as the JSON', () => {
    const raw = (JSON.parse(jsonText) as { parts: RawFields[] }).parts;
    const fromJson = raw.map(decodeJsonPart);
    const grids = uriGrids();
    const fresh = decodeUriBinary(buildUriAsset(jsonText).bin.slice().buffer);
    grids.forEach((g, pi) => {
      for (const f of ['mat', 'surf', 'tone', 'form', 'nx', 'ny', 'nz', 'edge', 'chunk'] as const) {
        expect(Array.from(g[f])).toEqual(Array.from(fromJson[pi]![f]));
        expect(Array.from(fresh[pi]![f])).toEqual(Array.from(fromJson[pi]![f]));
      }
    });
    const a = uriPartMatterFrom(fromJson);
    const b = uriPartMatter();
    a.forEach((pa, i) => {
      const pb = b[i]!;
      expect(pb.key).toBe(pa.key);
      for (const f of ['material', 'density', 'baseColor', 'height'] as const)
        expect(Buffer.compare(Buffer.from(pb.map[f].buffer), Buffer.from(pa.map[f].buffer))).toBe(0);
      expect([pb.map.coreX, pb.map.coreY]).toEqual([pa.map.coreX, pa.map.coreY]);
      expect(Array.from(pb.chunks)).toEqual(Array.from(pa.chunks));
      expect(Buffer.compare(Buffer.from(pb.light), Buffer.from(pa.light))).toBe(0);
      expect(Buffer.compare(Buffer.from(pb.shade), Buffer.from(pa.shade))).toBe(0);
    });
  });

  it('rejects a stale or foreign file', () => {
    const bad = new Uint8Array(64);
    expect(() => decodeUriBinary(bad.buffer)).toThrow(/URIB/);
  });
});
