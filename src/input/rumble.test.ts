import { describe, expect, it } from 'vitest';
import { RumbleGate, hasRumble, playRumble } from './rumble';
import { proStandard } from './testing';

describe('RumbleGate', () => {
  it('rate-limits a stream of equal effects but lets a stronger blow through', () => {
    const g = new RumbleGate(45);
    expect(g.admit(0, 0.5, 200)).toBe(true);
    expect(g.admit(16, 0.5, 200)).toBe(false);
    expect(g.admit(32, 0.4, 200)).toBe(false);
    expect(g.admit(40, 1, 300)).toBe(true); // clearly stronger cuts through
    expect(g.admit(500, 0.2, 100)).toBe(true); // quiet again
  });
  it('reset clears it', () => {
    const g = new RumbleGate();
    g.admit(0, 1, 1000);
    g.reset();
    expect(g.admit(1, 0.1, 10)).toBe(true);
  });
});

describe('playRumble', () => {
  it('plays a clamped dual-rumble effect through vibrationActuator', () => {
    const p = proStandard().withRumble();
    expect(playRumble(p, 2, -1, 99999)).toBe(true);
    expect(p.effects).toEqual([
      {
        type: 'dual-rumble',
        params: { startDelay: 0, duration: 2000, weakMagnitude: 0, strongMagnitude: 1 },
      },
    ]);
  });
  it('falls back to hapticActuators[0].pulse', () => {
    const pulses: [number, number][] = [];
    const p = proStandard();
    p.hapticActuators = [{ pulse: (v: number, d: number) => void pulses.push([v, d]) }];
    expect(hasRumble(p)).toBe(true);
    expect(playRumble(p, 0.3, 0.8, 120)).toBe(true);
    expect(pulses).toEqual([[0.8, 120]]);
  });
  it('never throws and swallows rejected promises', async () => {
    const p = proStandard();
    p.vibrationActuator = {
      playEffect: () => Promise.reject(new Error('device busy')),
    };
    expect(playRumble(p, 1, 1, 100)).toBe(true);
    await Promise.resolve();
    const q = proStandard();
    q.vibrationActuator = {
      playEffect: () => {
        throw new Error('nope');
      },
    };
    expect(playRumble(q, 1, 1, 100)).toBe(false);
    expect(playRumble(null, 1, 1, 100)).toBe(false);
    expect(playRumble(proStandard(), 1, 1, 100)).toBe(false); // no actuator
  });
});
