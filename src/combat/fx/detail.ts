/**
 * Render-only detail level of the behaviours' CPU-rasterised effects (S19): 2 = full, 1 = normal, 0 = light. The app sets
 * it every frame from the renderer's adaptive quality tier (src/render/quality.ts), so a machine that drops frames also
 * sheds CPU work in the big overlays (the Cradle's membrane, the living sail …).
 *
 * It is read ONLY by drawing that runs at render time (`renderLayers`), never by anything in the sim tick: the simulation
 * and its hashes are identical at every level (src/combat/renderpure.test.ts).
 */
export const FX_DETAIL = { level: 2 as 0 | 1 | 2 };
