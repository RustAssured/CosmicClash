/**
 * Generate docs/TITANS.md from the titan JSON definitions (the JSON is the source of truth — never edit the markdown by hand).
 *   npx tsx tools/titans/docs.ts
 */
import { writeFileSync } from 'node:fs';
import {
  DamageFlag,
  totalTicks,
  validateTitanDef,
  type HitboxDef,
  type MoveDef,
  type TitanDef,
} from '@/contracts';
import { TITAN_DEFS } from '@/titans';

const flagNames = (f: number): string =>
  (Object.entries(DamageFlag) as [string, number][])
    .filter(([, v]) => (f & v) !== 0)
    .map(([k]) => k)
    .join('|') || '—';

const secs = (t: number): string => `${(t / 60).toFixed(2)} s`;

function hitboxRow(hb: HitboxDef): string {
  const p = hb.damage.params;
  const params = Object.entries(p)
    .map(([k, v]) => `${k}=${v}`)
    .join(', ');
  return `| ${hb.id} | ${hb.from}–${hb.to} | ${hb.shape.kind}${hb.sweepTo ? ' (sweeps)' : ''} | ${hb.damage.type} | ${hb.damage.energy}${hb.rehit ? ` /${hb.rehit}t` : ''} | ${flagNames(hb.damage.flags)} | ${params || '—'} | ${hb.knockback.x},${hb.knockback.y} | ${hb.guardPressure} |`;
}

function moveSection(m: MoveDef): string {
  const f = m.frame;
  const lines: string[] = [];
  lines.push(`#### ${m.name}${m.nameKo ? ` · ${m.nameKo}` : ''}  \`${m.id}\`  — ${m.slot}`);
  lines.push('');
  const tags = m.tags.length ? ` Tags: ${m.tags.map((t) => `\`${t}\``).join(' ')}.` : '';
  const cost = [m.resourceCost ? `resource ${m.resourceCost}` : '', m.meterCost ? `meter ${m.meterCost}` : '']
    .filter(Boolean)
    .join(', ');
  lines.push(
    `Startup **${f.startup}** · active **${f.active}** · recovery **${f.recovery}** = **${totalTicks(f)} ticks** (${secs(totalTicks(f))}); cancel window ${f.cancelWindow}${f.chargeMax ? `; hold up to ${f.chargeMax} ticks to charge` : ''}; hit-stop base ${f.hitstop}.${cost ? ` Cost: ${cost}.` : ''}${m.intangible ? ` Intangible ticks [${m.intangible[0]}, ${m.intangible[1]}).` : ''}${tags}`,
  );
  const aims = (['up', 'forward', 'down'] as const).filter((a) => m.variants[a].hitboxes.length > 0);
  if (aims.length) {
    const v = m.variants.forward.hitboxes.length ? m.variants.forward : m.variants[aims[0]!];
    lines.push('');
    lines.push('Forward-aim hitboxes (ticks relative to the first active tick; lengths at REACH 5):');
    lines.push('');
    lines.push('| hitbox | window | shape | type | energy | flags | params | knockback | guard |');
    lines.push('|---|---|---|---|---|---|---|---|---|');
    for (const hb of v.hitboxes) lines.push(hitboxRow(hb));
    const total = aims.map((a) =>
      m.variants[a].hitboxes.reduce(
        (s, h) => s + h.damage.energy * (h.damage.flags & DamageFlag.CONTINUOUS ? h.to - h.from : 1),
        0,
      ),
    );
    lines.push('');
    lines.push(
      `Aims with hitboxes: ${aims.join(', ')}. Total nominal energy if everything connects (forward): ${Math.round(total[aims.indexOf('forward') >= 0 ? aims.indexOf('forward') : 0]!)}.`,
    );
  }
  if (m.extra) lines.push('', 'Data-driven extras: `' + JSON.stringify(m.extra) + '`');
  lines.push('');
  return lines.join('\n');
}

function titanSection(def: TitanDef): string {
  const a = def.attributes;
  const out: string[] = [];
  out.push(`## ${def.name} · ${def.nameKo} — *${def.epithet}*`);
  out.push('');
  out.push(`> ${def.ui.tagline}`);
  out.push('');
  out.push(`| MASS | COHESION | HEAT | GRAVITY | REACH | TEMPO |`);
  out.push(`|---|---|---|---|---|---|`);
  out.push(`| ${a.mass} | ${a.cohesion} | ${a.heat} | ${a.gravity} | ${a.reach} | ${a.tempo} |`);
  out.push('');
  out.push(`- **Destruction signature:** ${def.destruction}`);
  out.push(
    `- **Resource:** ${def.resource.name} (${def.resource.nameKo}) — max ${def.resource.max}, start ${def.resource.start}, shown as ${def.resource.display}`,
  );
  out.push(`- **Passive — ${def.passive.name}:** ${def.passive.text}`);
  out.push(`- **Failure mode — ${def.failureMode.name}:** ${def.failureMode.text}`);
  out.push(`- **AI personality:** ${def.ai.style}`);
  out.push(`- **Accent colours:** \`${def.ui.accent}\`, \`${def.ui.accent2}\``);
  out.push(
    `- **Art recipe:** ${def.art.w}×${def.art.h} map, core (${def.art.coreX}, ${def.art.coreY}) r=${def.art.coreRadius}`,
  );
  out.push('');
  out.push('### Materials');
  out.push('');
  out.push('| key | physics archetype | overrides | emissive | ramp (dark → light) |');
  out.push('|---|---|---|---|---|');
  for (const m of def.materials) {
    const ov = m.physics
      ? Object.entries(m.physics)
          .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
          .join(', ')
      : '—';
    out.push(
      `| ${m.key} | ${m.base} | ${ov} | ${m.visual.emissive} | ${m.visual.ramp.map((c) => `\`${c}\``).join(' ')} |`,
    );
  }
  out.push('');
  out.push('### Moves');
  out.push('');
  const strikes = def.moves.filter((m) => m.slot !== 'guard');
  out.push('| move | slot | startup | active | recovery | total | seconds |');
  out.push('|---|---|---|---|---|---|---|');
  for (const m of strikes)
    out.push(
      `| ${m.name} | ${m.slot} | ${m.frame.startup} | ${m.frame.active} | ${m.frame.recovery} | ${totalTicks(m.frame)} | ${secs(totalTicks(m.frame))} |`,
    );
  const g = def.moves.find((m) => m.slot === 'guard');
  if (g) {
    const shell = (g.extra?.['shell'] as { absorb: Record<string, number> }).absorb;
    out.push('');
    out.push(
      `**Guard — ${g.name}:** absorbs ${Object.entries(shell)
        .map(([k, v]) => `${k} ${(v * 100).toFixed(0)}%`)
        .join(' · ')} of incoming energy while healthy.`,
    );
  }
  out.push('');
  for (const m of def.moves) out.push(moveSection(m));
  const errs = validateTitanDef(def);
  out.push(`Validation against the feel targets: ${errs.length ? errs.join('; ') : 'all clear'}.`);
  out.push('');
  return out.join('\n');
}

const parts: string[] = [];
parts.push('# Titans — data reference');
parts.push('');
parts.push(
  '> Generated by `npx tsx tools/titans/docs.ts` from `src/titans/*.json`. **Do not edit by hand** — edit the JSON and regenerate.',
);
parts.push('');
parts.push(
  'Frame data is in **ticks** (60 Hz). Feel targets (enforced by `validateTitanDef`, DESIGN §4): Strike 30–48 ticks total · Crush 72–120 total with 21–42 startup · Ultimate 180–300 · windup cancels in the first 40% of startup.',
);
parts.push(
  'Lengths in hitbox templates are authored at REACH 5 and scaled by `(reach/5)^reachScale` (default 1) and by the live `reachMul` from remaining mass.',
);
parts.push('');
parts.push(
  'Control mapping recap: Y **Strike** · X **Crush** · B **Surge** · A **Signature** (hold to charge where allowed) · ZR **Ultimate** (meter full) · ZL **Guard** (hold) · L/R **Feint**.',
);
parts.push('');
for (const def of Object.values(TITAN_DEFS)) if (def) parts.push(titanSection(def));
writeFileSync('docs/TITANS.md', parts.join('\n'));
console.log('wrote docs/TITANS.md');
