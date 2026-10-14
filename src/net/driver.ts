import { emptyInput, type InputFrame, type InputSource } from '@/contracts';
import { HASH_EVERY, type Lockstep } from './lockstep';

/** The part of a Match the driver needs (the real Match, or a test double). */
export interface DrivenMatch {
  readonly tick: number;
  readonly phase: string;
  setSources(a: InputSource | null, b: InputSource | null): void;
  checksum(): number;
  hash(): number;
}

/**
 * Glue between one Match and its Lockstep: the app (or a test) calls `beforeStep()` once per loop tick; when it returns
 * true it steps the match and then calls `afterStep()`. The match's two input sources read the lockstep log.
 *
 * After the match reaches 'matchend' the result is decided on both sides; the driver then lets the match run on by itself
 * (empty inputs, nothing compared), so the results screen's timing never waits on the network.
 */
export class NetMatchDriver {
  readonly lockstep: Lockstep;
  /** Loop ticks spent waiting for the peer in a row (the "waiting" indicator), and in total. */
  stalled = 0;
  stalledTotal = 0;
  /** Set by the session when it stops the match (desync, connection lost, opponent left): nothing steps any more. */
  halted = false;
  private readonly tmp: InputFrame = emptyInput();
  private match: DrivenMatch | null = null;
  private local: InputSource | null = null;

  constructor(
    lockstep: Lockstep,
    private readonly send: (bytes: Uint8Array) => void,
  ) {
    this.lockstep = lockstep;
  }

  /** Bind the match and the local player's input (a device or, for tests, an AI). Sets both of the match's sources. */
  attach(match: DrivenMatch, local: InputSource): void {
    this.match = match;
    this.local = local;
    const ls = this.lockstep;
    const src = (slot: 0 | 1): InputSource => ({
      kind: 'human',
      poll: (tick, out) => {
        if (ls.done) {
          out.moveX = out.moveY = 0;
          out.held = out.pressed = out.released = 0;
          return;
        }
        ls.frame(slot, tick, out);
      },
    });
    match.setSources(src(0), src(1));
  }

  get freeRunning(): boolean {
    return this.lockstep.done;
  }

  /** Sample the local input if it is due, send our packet, and say whether the next tick can be simulated. */
  beforeStep(): boolean {
    const ls = this.lockstep;
    if (ls.desync || this.halted) return false;
    if (ls.done) return true;
    while (ls.needLocal() && this.local) {
      this.local.poll(ls.localNext, this.tmp);
      ls.pushLocal(this.tmp);
    }
    this.flush();
    if (!ls.ready()) {
      this.stalled++;
      this.stalledTotal++;
      return false;
    }
    this.stalled = 0;
    return true;
  }

  /** The match just stepped: record its checksum (and hash on hash ticks). */
  afterStep(): void {
    const m = this.match;
    const ls = this.lockstep;
    if (!m || ls.done) return;
    if (m.tick !== ls.simTick + 1) {
      // the app stepped the match without asking: lockstep is broken, treat it as a desync of our own making
      ls.desync = ls.desync ?? { tick: m.tick, kind: 'checksum', local: 0, remote: 0 };
      return;
    }
    ls.stepped(m.tick, m.checksum(), m.tick % HASH_EVERY === 0 ? m.hash() : undefined);
    if (m.phase === 'matchend') {
      // one last packet so the peer can compare our final checksum, then free-run
      this.flush();
      ls.done = true;
    }
  }

  /** Send the redundant input packet now (also called by the session's heartbeat while the loop is stalled or hidden). */
  flush(): void {
    this.send(this.lockstep.packet());
  }

  receive(bytes: Uint8Array): void {
    this.lockstep.receive(bytes);
  }
}
