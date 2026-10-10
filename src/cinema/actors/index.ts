import type { ActorFactory } from '../types';

/**
 * The actor registry: timeline.json names an actor by `type`; its module registers a factory here. Each actor lives in its
 * own file in this folder (S5: world, matter-cam; S7: genesis, ark, parallax) and imports nothing from the others.
 */
const FACTORIES = new Map<string, ActorFactory>();

export function registerActor(type: string, factory: ActorFactory): void {
  if (FACTORIES.has(type)) throw new Error(`cinema actor type "${type}" is registered twice`);
  FACTORIES.set(type, factory);
}

export function actorFactory(type: string): ActorFactory {
  const f = FACTORIES.get(type);
  if (!f)
    throw new Error(
      `unknown cinema actor type "${type}" (registered: ${[...FACTORIES.keys()].join(', ') || 'none'})`,
    );
  return f;
}

export function actorTypes(): string[] {
  return [...FACTORIES.keys()];
}
