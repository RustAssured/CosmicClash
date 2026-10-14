import type { StageId, TitanId } from '@/contracts';
import type { DesyncInfo } from './lockstep';

/**
 * What the ONLINE screens (src/ui/screens/online.ts) see of the session, and may ask of it. The UI never touches links,
 * sockets or the lockstep: it draws `view` and calls these methods.
 */
export type OnlinePhase =
  /** CREATE ROOM / JOIN ROOM */
  | 'menu'
  /** typing a room code */
  | 'code'
  /** asking the worker for a room */
  | 'creating'
  /** room open, code and link shown, waiting for the friend */
  | 'waiting'
  /** finding the room / connecting the peer-to-peer link / comparing builds */
  | 'connecting'
  /** both pick titans */
  | 'select'
  /** both locked: the host picks the stage, the guest waits */
  | 'stage'
  /** 3-2-1 before the match */
  | 'countdown'
  /** the match is running (the online screen only shows on top of it for the LEAVE prompt) */
  | 'match'
  /** after the results: waiting for the other player to accept a rematch */
  | 'rematch'
  /** a stop: error, opponent left, connection lost, desync */
  | 'error';

export interface OnlineView {
  phase: OnlinePhase;
  role: 'host' | 'guest' | null;
  code: string | null;
  link: string | null;
  /** 'local' when testing over BroadcastChannel (shown on screen). */
  transport: 'worker' | 'local' | 'off';
  myPick: TitanId;
  myLocked: boolean;
  peerPick: TitanId | null;
  peerLocked: boolean;
  stage: StageId | 'random';
  /** Seconds left on the countdown. */
  countdown: number;
  /** Median round trip and the input delay in ticks the next / current match uses. */
  pingMs: number | null;
  delay: number;
  /** In a match: ticks the sim has been waiting for the peer's input (0 = flowing). */
  waiting: number;
  /** Seconds left of the reconnect grace period while the link is down (0 = up). */
  reconnecting: number;
  /** The LEAVE prompt is up over a running match. */
  leaveAsk: boolean;
  peerWantsRematch: boolean;
  error: { en: string; ko: string; detail?: string } | null;
  desync: DesyncInfo | null;
  /** True for a moment after the link was copied to the clipboard (false: copy failed, null: not tried). */
  copied: boolean | null;
}

export interface OnlineUiPort {
  readonly view: Readonly<OnlineView>;
  /** Titans and stages the online select offers (the same build on both sides offers the same). */
  readonly titans: readonly TitanId[];
  readonly stages: readonly StageId[];
  openMenu(): void;
  host(): void;
  openCode(): void;
  join(code: string): void;
  /** Back to the title, closing everything (sends a goodbye). */
  leave(): void;
  pick(titan: TitanId): void;
  lock(on: boolean): void;
  chooseStage(stage: StageId | 'random'): void;
  confirmStage(): void;
  rematch(): void;
  /** Close the LEAVE prompt and go back to the match. */
  resume(): void;
  copyLink(): void;
  /** Download the last desync report (JSON). */
  saveLog(): void;
}
