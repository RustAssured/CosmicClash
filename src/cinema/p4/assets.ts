import { bakeUri, type RgbaImage, type UriBake } from './uri';

/**
 * 우리's baked sprites for the P4 actors, loaded once. In the browser (the engine's cinema mode) the four PNGs are fetched
 * as Vite assets and decoded through a canvas; a Node tool decodes them itself (pngjs) and hands the bake in with
 * `provideUriBake`, so this module never touches the file system.
 */
const NAMES = ['uri-a', 'uri-a-id', 'uri-g', 'uri-g-id'] as const;
const URLS: Record<(typeof NAMES)[number], string> = {
  'uri-a': new URL('../assets/uri-a.png', import.meta.url).href,
  'uri-a-id': new URL('../assets/uri-a-id.png', import.meta.url).href,
  'uri-g': new URL('../assets/uri-g.png', import.meta.url).href,
  'uri-g-id': new URL('../assets/uri-g-id.png', import.meta.url).href,
};

let pending: Promise<UriBake> | null = null;
let ready: UriBake | null = null;

/** Hand in a bake made elsewhere (Node tools). */
export function provideUriBake(b: UriBake): void {
  ready = b;
  pending = Promise.resolve(b);
}

/** The bake, once loaded (null before). */
export const uriBakeNow = (): UriBake | null => ready;

async function decode(url: string): Promise<RgbaImage> {
  const blob = await (await fetch(url)).blob();
  const bmp = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  const cv = new OffscreenCanvas(bmp.width, bmp.height);
  const g = cv.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(bmp, 0, 0);
  const d = g.getImageData(0, 0, bmp.width, bmp.height);
  return { width: d.width, height: d.height, data: d.data };
}

/** Load and bake (browser), once. */
export function loadUriBake(): Promise<UriBake> {
  return (pending ??= Promise.all(NAMES.map((n) => decode(URLS[n]))).then(([a, ai, g, gi]) => {
    ready = bakeUri(a!, ai!, g!, gi!);
    return ready;
  }));
}
