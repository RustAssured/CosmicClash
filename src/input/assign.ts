/**
 * Default P1/P2 device assignment (pure).
 *
 * Rules, in order: a slot the player assigned by hand keeps its device. Every other slot takes the first still-unused
 * candidate from [pads in connection order …, keyboard 1, keyboard 2]. So: no pads → P1 WASD / P2 arrows; one pad →
 * P1 pad / P2 WASD; two pads → P1 pad / P2 pad. "First activated pad → P1" falls out of connection order.
 */
export function computeAutoAssignment(
  padIds: readonly string[],
  manual: readonly [string | null, string | null],
  keyboardIds: readonly string[] = ['kb1', 'kb2'],
): [string | null, string | null] {
  const out: [string | null, string | null] = [manual[0], manual[1]];
  const used = new Set<string>();
  for (const m of manual) if (m) used.add(m);
  const pool = [...padIds, ...keyboardIds];
  for (const slot of [0, 1] as const) {
    if (out[slot]) continue;
    const pick = pool.find((id) => !used.has(id));
    if (pick) {
      out[slot] = pick;
      used.add(pick);
    }
  }
  return out;
}
