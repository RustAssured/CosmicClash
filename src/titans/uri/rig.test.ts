import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { uriPartMatter } from './maps';
import {
  apply,
  armTransforms,
  bodyTransforms,
  emptyPlaces,
  placeParts,
  restPose,
  URI_ORDER,
  URI_PARTS,
  URI_REF,
  uriPart,
  type UriPose,
} from './rig';

describe('우리 rig (URI_SPEC §4)', () => {
  it('has the 13 parts of the asset, drawn back → front in the spec order', () => {
    expect(URI_PARTS.map((p) => p.key).sort()).toEqual(
      [
        'chamber',
        'domeL',
        'domeR',
        'faL',
        'faR',
        'fistL',
        'fistR',
        'moon',
        'pelvis',
        'pyL',
        'pyR',
        'uaL',
        'uaR',
      ].sort(),
    );
    expect(URI_ORDER).toEqual([
      'pyL',
      'pyR',
      'pelvis',
      'uaL',
      'uaR',
      'domeL',
      'domeR',
      'chamber',
      'faL',
      'faR',
      'fistL',
      'fistR',
      'moon',
    ]);
    // every part's grid sits on whole pixels: pivot in reference space − pivot in the grid = the grid's corner
    for (const p of URI_PARTS) {
      expect(Math.abs(p.pgX - p.pivX - p.x0)).toBeLessThan(1e-6);
      expect(Math.abs(p.pgY - p.pivY - p.y0)).toBeLessThan(1e-6);
    }
  });

  it('at rest every transform is the identity: each pivot is at its reference place, unrotated', () => {
    const pl = placeParts(restPose(), emptyPlaces());
    for (const p of URI_PARTS) {
      expect(pl[p.key].x).toBeCloseTo(p.pgX, 9);
      expect(pl[p.key].y).toBeCloseTo(p.pgY, 9);
      expect(pl[p.key].a).toBe(0);
    }
  });

  it('composes parent → child: every joint is the same point seen from both sides, in any pose', () => {
    const pose: UriPose = {
      ...restPose(),
      hx: 7,
      hy: -5,
      ha: 0.1,
      ta: -0.2,
      daL: 0.3,
      daR: -0.25,
      dxL: 6,
      dxR: -4,
      sL: 1.1,
      sR: -0.9,
      eL: 0.7,
      eR: -1.2,
      wL: 0.4,
      wR: -0.5,
    };
    const B = bodyTransforms(pose);
    const a = { x: 0, y: 0 };
    const b = { x: 0, y: 0 };
    for (const s of ['L', 'R'] as const) {
      const ua = uriPart(s === 'L' ? 'uaL' : 'uaR');
      const fa = uriPart(s === 'L' ? 'faL' : 'faR');
      const dome = s === 'L' ? B.domeL : B.domeR;
      const A = armTransforms(s, dome, pose);
      // the shoulder stays on the ark, the elbow on the upper arm, the wrist on the forearm
      apply(dome, ua.ja![0], ua.ja![1], a);
      apply(A.sh, ua.ja![0], ua.ja![1], b);
      expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeLessThan(1e-9);
      apply(A.sh, ua.jb![0], ua.jb![1], a);
      apply(A.el, ua.jb![0], ua.jb![1], b);
      expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeLessThan(1e-9);
      apply(A.el, fa.jb![0], fa.jb![1], a);
      apply(A.wr, fa.jb![0], fa.jb![1], b);
      expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeLessThan(1e-9);
      // a child's angle is its parent's plus its own link
      expect(A.wr.a).toBeCloseTo(
        dome.a + (s === 'L' ? pose.sL + pose.eL + pose.wL : pose.sR + pose.eR + pose.wR),
        12,
      );
    }
    // the torso turns about its own pivot: that point moves only with the hips
    const tc = [uriPart('chamber').pgX, uriPart('pelvis').pgY - 14] as const;
    apply(B.hip, tc[0], tc[1], a);
    apply(B.torso, tc[0], tc[1], b);
    expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeLessThan(1e-9);
  });

  it('the rest pose covers the reference silhouette (uri_silhouette_rest.png) at reference scale', () => {
    const png = PNG.sync.read(readFileSync('uri/data/uri_silhouette_rest.png'));
    expect([png.width, png.height]).toEqual([URI_REF.w, URI_REF.h]);
    const body = new Uint8Array(png.width * png.height);
    for (const pm of uriPartMatter(1)) {
      const meta = uriPart(pm.key);
      const m = pm.map;
      for (let iy = 0; iy < m.h; iy++)
        for (let ix = 0; ix < m.w; ix++) {
          if (!m.material[iy * m.w + ix]) continue;
          const x = meta.x0 + ix;
          const y = meta.y0 + iy;
          if (x >= 0 && y >= 0 && x < png.width && y < png.height) body[y * png.width + x] = 1;
        }
    }
    let sil = 0;
    let covered = 0;
    let extra = 0;
    for (let i = 0; i < body.length; i++) {
      const on =
        png.data[i * 4 + 3]! > 127 && png.data[i * 4]! + png.data[i * 4 + 1]! + png.data[i * 4 + 2]! > 0;
      if (on) {
        sil++;
        if (body[i]) covered++;
      } else if (body[i]) extra++;
    }
    expect(sil).toBeGreaterThan(1000);
    expect(covered / sil).toBe(1);
    expect(extra).toBe(0);
  });
});
