/**
 * A peer-to-peer link with two lanes (docs/netplay/STEP1.md §1):
 *  - the INPUT lane: unordered and unreliable (a WebRTC DataChannel with `ordered: false, maxRetransmits: 0`). Lockstep
 *    packets carry every unacknowledged input, so a lost or late datagram costs nothing and never blocks the ones after it;
 *  - the CONTROL lane: ordered and reliable, for the handshake, picks, start, rematch and goodbyes (JSON).
 */
export type LinkState = 'connecting' | 'open' | 'interrupted' | 'closed';

export interface LinkHandlers {
  fast(bytes: Uint8Array): void;
  control(msg: ControlMsg): void;
  state(s: LinkState): void;
}

export interface NetLink {
  readonly state: LinkState;
  sendFast(bytes: Uint8Array): void;
  sendControl(msg: ControlMsg): void;
  close(): void;
}

/** Control-lane messages. */
export type ControlMsg =
  | { t: 'hello'; build: string; tuned: boolean; titans: string[] }
  | { t: 'refuse'; reason: 'build' | 'tuned' }
  | { t: 'pick'; titan: string; locked: boolean }
  | { t: 'stage'; stage: string }
  | { t: 'start'; epoch: number; delay: number; config: unknown }
  | { t: 'rematch' }
  | { t: 'desync'; tick: number; kind: string; local: number; remote: number }
  | { t: 'bye' };

export function isControlMsg(v: unknown): v is ControlMsg {
  return typeof v === 'object' && v !== null && typeof (v as { t?: unknown }).t === 'string';
}
