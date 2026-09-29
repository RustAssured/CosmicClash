import {
  AddEquation,
  CustomBlending,
  DoubleSide,
  Mesh,
  OneFactor,
  OneMinusSrcAlphaFactor,
  OrthographicCamera,
  RawShaderMaterial,
  Scene,
  SrcAlphaFactor,
  Vector2,
  Vector4,
  ZeroFactor,
  GLSL3,
  type WebGLRenderer,
  type WebGLRenderTarget,
} from 'three';
import { LOGICAL_H, LOGICAL_W, type RenderLayer, type ViewRect } from '@/contracts';
import { compileScene, unitQuad } from './gl';
import { makePlacement, placeLayer, type LayerPlacement } from './layerMap';
import type { LayerTextures } from './layerTextures';
import { LAYER_FRAG, LAYER_VERT } from './shaders';

/** Maximum number of 2D layers composited per frame (extra layers are dropped with one warning). */
export const MAX_LAYERS = 48;

interface Slot {
  mesh: Mesh;
  material: RawShaderMaterial;
  rect: Vector4;
  size: Vector2;
  place: Vector4;
  fl: Vector2;
}

/**
 * Draws every `RenderLayer` (sorted by z) into the colour + emissive attachments of the layer target, with nearest
 * filtering at integer positions, mirror / row-shear done in the fragment shader (see `layerMap.ts`).
 */
export class LayerCompositor {
  private readonly scene = new Scene();
  private readonly camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly slots: Slot[] = [];
  private readonly sorted: RenderLayer[] = [];
  private readonly place: LayerPlacement = makePlacement();
  private warned = false;
  /** Layers drawn last frame (for stats/tests). */
  drawn = 0;
  private readonly res = new Vector2(LOGICAL_W, LOGICAL_H);

  constructor(
    private readonly textures: LayerTextures,
    private readonly emisGain: { value: number },
  ) {
    for (let i = 0; i < MAX_LAYERS; i++) this.slots.push(this.makeSlot(i));
  }

  private makeSlot(i: number): Slot {
    const rect = new Vector4();
    const size = new Vector2();
    const place = new Vector4();
    const fl = new Vector2(1, 0);
    const material = new RawShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: LAYER_VERT,
      fragmentShader: LAYER_FRAG,
      uniforms: {
        uRes: { value: this.res },
        uRect: { value: rect },
        uTex: { value: null },
        uEmis: { value: null },
        uHasEmis: { value: 0 },
        uSize: { value: size },
        uPlace: { value: place },
        uFL: { value: fl },
        uScreen: { value: 0 },
        uAlpha: { value: 1 },
        uEmisGain: this.emisGain,
      },
      depthTest: false,
      depthWrite: false,
      transparent: true,
      side: DoubleSide,
    });
    setLayerBlend(material, 'normal');
    const mesh = new Mesh(unitQuad(), material);
    mesh.frustumCulled = false;
    mesh.renderOrder = i;
    mesh.visible = false;
    this.scene.add(mesh);
    return { mesh, material, rect, size, place, fl };
  }

  /** Stable insertion sort by z into a reused array (zero allocation; layer counts are small). */
  private sortLayers(layers: readonly RenderLayer[]): number {
    const s = this.sorted;
    let n = 0;
    for (const l of layers) {
      if (!l.visible || l.alpha <= 0 || l.w <= 0 || l.h <= 0) continue;
      if (n >= MAX_LAYERS) {
        if (!this.warned) {
          console.warn(`renderer: more than ${MAX_LAYERS} layers in a frame; extra layers dropped`);
          this.warned = true;
        }
        break;
      }
      let j = n;
      while (j > 0 && s[j - 1]!.z > l.z) {
        s[j] = s[j - 1]!;
        j--;
      }
      s[j] = l;
      n++;
    }
    s.length = n;
    return n;
  }

  draw(
    renderer: WebGLRenderer,
    target: WebGLRenderTarget,
    layers: readonly RenderLayer[],
    view: ViewRect,
    alpha: number,
  ): number {
    const n = this.sortLayers(layers);
    let used = 0;
    for (let i = 0; i < MAX_LAYERS; i++) this.slots[i]!.mesh.visible = false;
    for (let i = 0; i < n; i++) {
      const layer = this.sorted[i]!;
      const p = this.place;
      placeLayer(layer, view, alpha, p);
      // Off-screen world layers cost nothing: skip if the destination rect misses the frame entirely.
      if (p.x1 <= 0 || p.y1 <= 0 || p.x0 >= LOGICAL_W || p.y0 >= LOGICAL_H) {
        this.textures.acquire(layer); // still keep its texture current so re-entry is instant
        continue;
      }
      const gpu = this.textures.acquire(layer);
      const slot = this.slots[used++]!;
      slot.mesh.visible = true;
      slot.mesh.renderOrder = used;
      const u = slot.material.uniforms;
      // Clip the quad to the frame (the shader still maps by absolute pixel, so clipping is invisible).
      slot.rect.set(
        Math.max(0, p.x0),
        Math.max(0, p.y0),
        Math.min(LOGICAL_W, p.x1),
        Math.min(LOGICAL_H, p.y1),
      );
      slot.size.set(layer.w, layer.h);
      slot.place.set(p.ax, p.ay, p.anchorX, p.anchorY);
      slot.fl.set(p.facing, p.lean);
      u.uTex!.value = gpu.tex;
      u.uEmis!.value = gpu.emis;
      u.uHasEmis!.value = gpu.emis ? 1 : 0;
      u.uScreen!.value = p.screen ? 1 : 0;
      u.uAlpha!.value = layer.alpha;
      setLayerBlend(slot.material, layer.blend);
    }
    this.drawn = used;
    // The target is a dedicated layer target: it starts each frame transparent, so what it holds afterwards is exactly
    // the premultiplied "over" chain of this frame's layers (colour + alpha, and emissive + alpha).
    renderer.setRenderTarget(target);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, false, false);
    if (used > 0) renderer.render(this.scene, this.camera);
    return used;
  }

  /** Compile the layer program (all slots share it) before the first frame. */
  compile(renderer: WebGLRenderer): Promise<void> {
    for (const s of this.slots) s.mesh.visible = false;
    this.slots[0]!.mesh.visible = true;
    return compileScene(renderer, this.scene, this.camera).then(() => {
      this.slots[0]!.mesh.visible = false;
    });
  }

  dispose(): void {
    for (const s of this.slots) s.material.dispose();
  }
}

function setLayerBlend(m: RawShaderMaterial, blend: 'normal' | 'add'): void {
  m.blending = CustomBlending;
  m.blendEquation = AddEquation;
  if (blend === 'add') {
    m.blendSrc = SrcAlphaFactor;
    m.blendDst = OneFactor;
    // additive glows must not become occluders for god rays
    m.blendSrcAlpha = ZeroFactor;
    m.blendDstAlpha = OneFactor;
  } else {
    m.blendSrc = SrcAlphaFactor;
    m.blendDst = OneMinusSrcAlphaFactor;
    m.blendSrcAlpha = OneFactor;
    m.blendDstAlpha = OneMinusSrcAlphaFactor;
  }
}
