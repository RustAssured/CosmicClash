import { SpriteBuilder, type SceneryKit } from './kit';
import type { Rgb } from './color';

/**
 * Composition helpers shared by the stages. Every stage is DESIGNED as seen from one reference camera (the arena centre) in
 * screen pixels, then converted to layer coordinates for the parallax of the layer it lives on.
 */

/** Design-time camera: the scenery is composed as seen from the arena centre. */
export const REF_X0 = 480;
export const REF_Y0 = 110;

/** Convert a reference-screen position to layer coordinates for a layer with the given parallax. */
export const atRef = (sx: number, sy: number, p: number): [number, number] => [
  sx + REF_X0 * p,
  sy + REF_Y0 * p,
];

/** A pillar column placed by its screen position at the reference camera. */
export const atCol = (sx: number, topSy: number, p: number): { x: number; top: number } => ({
  x: sx + REF_X0 * p,
  top: topSy + REF_Y0 * p,
});

/** Screen position (logical px) of a layer-space point for the current view. */
export const screenOf = (
  layerX: number,
  layerY: number,
  parallax: number,
  view: { x0: number; y0: number },
  out: { x: number; y: number },
): void => {
  out.x = layerX - Math.floor(view.x0 * parallax + 0.5);
  out.y = layerY - Math.floor(view.y0 * parallax + 0.5);
};

/** A single bright star drawn as a core + halo + diffraction cross ('star' sprite profile). */
export interface HeroStar {
  /** Position at the reference camera (screen px). */
  sx: number;
  sy: number;
  /** Half size of the sprite (px): how far the diffraction spikes reach. */
  size: number;
  /** Core radius in px. */
  core: number;
  bright: number;
  tint: Rgb;
  parallax: number;
  rot: number;
}

/** Add each hero star as its own one-sprite layer (their profile parameters differ per star). */
export function addHeroStars(kit: SceneryKit, prefix: string, heroes: readonly HeroStar[]): void {
  heroes.forEach((h, i) => {
    const [x, y] = atRef(h.sx, h.sy, h.parallax);
    const b = new SpriteBuilder();
    b.push(
      x,
      y,
      0,
      i / heroes.length,
      h.size,
      h.size,
      h.rot,
      h.tint[0] * h.bright,
      h.tint[1] * h.bright,
      h.tint[2] * h.bright,
      1,
    );
    kit.addSprites(`${prefix}-${i}`, {
      buffer: b.build(),
      parallax: h.parallax,
      blend: 'add',
      profile: 'star',
      soft: h.core,
      twinkle: 0.05,
      forceK: 0.1,
    });
  });
}
