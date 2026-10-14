import { STAGE_IDS, TITAN_IDS, type MatchConfig, type StageId, type TitanId } from '@/contracts';
import { PKT_INPUT, PKT_PING, PKT_PONG, decodePing, encodePing } from './codec';
import { buildId, randomRoomCode, roomLink, type NetOptions } from './config';
import { NetMatchDriver } from './driver';
import type { ControlMsg, LinkHandlers, LinkState, NetLink } from './link';
import { Lockstep, delayFor, type DesyncInfo } from './lockstep';
import { createBroadcastLink } from './loopback';
import { RttStats } from './ping';
import { createRtcLink, isRtcSignal, type RtcLink, type RtcSignal } from './rtc';
import { SignalSocket, createRoom, fetchIceServers, type SignalError } from './signal';
import type { OnlinePhase, OnlineUiPort, OnlineView } from './types';

/** No packet for this long: the link counts as down and the reconnect countdown shows. */
const SILENT_MS = 2500;
/** How long a dropped link may take to come back before the session gives up. */
export const GRACE_MS = 10_000;
/** The same while the peer may still be loading the match's stage. */
const LOAD_GRACE_MS = 60_000;
const HEARTBEAT_MS = 100;
const PING_EVERY_MS = 500;
/** A guest gives up if the host has not answered by then (a local test tab may still be loading: longer). */
const JOIN_TIMEOUT_MS = 30_000;
const LOCAL_JOIN_TIMEOUT_MS = 90_000;
const COUNTDOWN_MS = 3000;
const REBUILD_EVERY_MS = 3000;

/** What the session needs from the app shell (src/app/app.ts implements it). */
export interface OnlineAppPort {
  /** The host's own match settings (Options › ROUND LENGTH, footwork…), written into the config both peers run. */
  matchSettings(): Required<Pick<MatchConfig, 'pace' | 'roundSeconds' | 'footwork' | 'zdepth'>>;
  /** Build and start the lockstep match (loads the stage first). */
  startOnline(config: MatchConfig, driver: NetMatchDriver, localSlot: 0 | 1, autoAi: number): void;
  /** Start preparing the stage's scenery now (during the countdown), so the match starts without a long load. */
  prepareStage(stage: MatchConfig['stage']): void;
  endMatch(): void;
  /** Show the ONLINE screen (over the match, if one is running). */
  showOnline(): void;
  showHud(): void;
  showTitle(): void;
  /** True if this tab's debug panel ever moved a live tuning knob (the sim would not match an untouched peer's). */
  tuned(): boolean;
}

const ERR = {
  setup: { en: 'ONLINE PLAY IS NOT SET UP YET', ko: '온라인 준비 중' },
  network: { en: 'COULD NOT REACH THE SERVER', ko: '서버 연결 실패' },
  notfound: { en: 'ROOM NOT FOUND', ko: '방을 찾을 수 없음' },
  full: { en: 'THE ROOM IS FULL', ko: '방이 가득 참' },
  expired: { en: 'THE ROOM HAS EXPIRED', ko: '방이 만료됨' },
  ratelimit: { en: 'TOO MANY TRIES - WAIT A MINUTE', ko: '잠시 후 다시' },
  badtoken: { en: 'THAT SEAT IS TAKEN', ko: '자리가 이미 있음' },
  badrequest: { en: 'THE SERVER REFUSED', ko: '서버 거부' },
  build: { en: 'DIFFERENT GAME VERSIONS', ko: '버전이 다름' },
  tuned: { en: 'DEBUG TUNING WAS USED', ko: '디버그 조정 사용됨' },
  lost: { en: 'CONNECTION LOST', ko: '연결 끊김' },
  left: { en: 'YOUR OPPONENT LEFT', ko: '상대가 나감' },
  desync: { en: 'DESYNC - THE GAMES DIVERGED', ko: '동기화 오류' },
  noconnect: { en: 'COULD NOT CONNECT', ko: '연결 실패' },
} as const;

/**
 * The online session: host / join, the handshake, the online select, the countdown, the lockstep match, results and
 * rematch, disconnects with a reconnect grace period, and desync reporting (docs/netplay/STEP1.md §3).
 */
export class OnlineController implements OnlineUiPort {
  readonly view: OnlineView;
  titans: TitanId[];
  readonly stages: StageId[];
  driver: NetMatchDriver | null = null;
  /** The last desync report (also on window.__ADEUK_NET__.lastDesync and in the console). */
  lastDesync: unknown = null;

  private link: NetLink | null = null;
  private signal: SignalSocket | null = null;
  private token: string | null = null;
  private ice: Promise<RTCIceServer[]> | null = null;
  private gen = 0;
  private epoch = 0;
  private config: MatchConfig | null = null;
  private readonly rtt = new RttStats();
  private pingId = 0;
  private lastPingAt = 0;
  private lastHeard = 0;
  private downSince = 0;
  private lastRebuild = 0;
  private heartbeat = 0;
  private helloSent = false;
  private peerHello = false;
  private countdownEnd = 0;
  private joinDeadline = 0;
  private meRematch = false;
  private peerGone = false;
  private signalRetryAt = 0;
  private autoAt = 0;
  private copiedUntil = 0;

  constructor(
    readonly opts: NetOptions,
    private readonly app: OnlineAppPort,
    titans: readonly TitanId[],
    stages: readonly StageId[],
    private readonly now: () => number = () => performance.now(),
  ) {
    this.titans = titans.filter((t) => t !== 'mouth');
    this.stages = [...stages];
    this.view = this.freshView();
    if (typeof window !== 'undefined') {
      (window as unknown as { __ADEUK_NET__: unknown }).__ADEUK_NET__ = {
        view: () => ({ ...this.view }),
        simTick: () => this.driver?.lockstep.simTick ?? 0,
        checksumAt: (t: number) => this.driver?.lockstep.checksumAt(t) ?? null,
        hashAt: (t: number) => this.driver?.lockstep.hashAt(t) ?? null,
        stalls: () => this.driver?.stalledTotal ?? 0,
        lockstep: () => {
          const ls = this.driver?.lockstep;
          return ls
            ? {
                delay: ls.delay,
                epoch: ls.epoch,
                simTick: ls.simTick,
                localNext: ls.localNext,
                remoteContig: ls.remoteContig,
                peerAck: ls.peerAck,
                packetsIn: ls.packetsIn,
                packetsBad: ls.packetsBad,
              }
            : null;
        },
        desync: () => this.driver?.lockstep.desync ?? null,
        lastDesync: () => this.lastDesync,
      };
    }
  }

  private freshView(): OnlineView {
    return {
      phase: 'menu',
      role: null,
      code: null,
      link: null,
      transport: this.opts.mode,
      myPick: this.titans[0] ?? ('planet' as TitanId),
      myLocked: false,
      peerPick: null,
      peerLocked: false,
      stage: 'random',
      countdown: 0,
      pingMs: null,
      delay: delayFor(null),
      waiting: 0,
      reconnecting: 0,
      leaveAsk: false,
      peerWantsRematch: false,
      error: null,
      desync: null,
      copied: null,
    };
  }

  /** True while an online match is running (the app locks the debug panels and pause). */
  get inMatch(): boolean {
    return this.view.phase === 'match' && this.driver !== null;
  }

  private setPhase(p: OnlinePhase): void {
    this.view.phase = p;
  }

  /* ---------------------------------------------------------------------------------------------- *
   *  UI port
   * ---------------------------------------------------------------------------------------------- */
  /** Back to CREATE / JOIN (closing any room). With no worker configured the menu says so and offers nothing. */
  openMenu(): void {
    this.reset();
  }

  openCode(): void {
    if (this.opts.mode === 'off') {
      this.fail(ERR.setup);
      return;
    }
    this.setPhase('code');
  }

  host(code?: string): void {
    this.reset();
    this.view.role = 'host';
    if (this.opts.mode === 'off') {
      this.fail(ERR.setup);
      return;
    }
    if (this.opts.mode === 'local') {
      this.setRoom(code ?? randomRoomCode());
      this.setPhase('waiting');
      this.useLink(
        createBroadcastLink(this.view.code!, 'host', this.opts.sim, this.handlersFor(), this.opts.bridge),
      );
      return;
    }
    this.setPhase('creating');
    void createRoom(this.opts.url).then(
      ({ code: c, token }) => {
        if (this.view.phase !== 'creating') return;
        this.token = token;
        this.ice = fetchIceServers(this.opts.url, c, token);
        this.setRoom(c);
        this.setPhase('waiting');
        this.openSignal();
      },
      (e: unknown) => this.failSignal(typeof e === 'string' ? (e as SignalError) : 'network'),
    );
  }

  join(code: string): void {
    this.reset();
    this.view.role = 'guest';
    if (this.opts.mode === 'off') {
      this.fail(ERR.setup);
      return;
    }
    this.setRoom(code);
    this.setPhase('connecting');
    this.joinDeadline = this.now() + (this.opts.mode === 'local' ? LOCAL_JOIN_TIMEOUT_MS : JOIN_TIMEOUT_MS);
    if (this.opts.mode === 'local') {
      this.useLink(createBroadcastLink(code, 'guest', this.opts.sim, this.handlersFor(), this.opts.bridge));
      return;
    }
    this.openSignal();
  }

  leave(): void {
    if (this.link?.state === 'open') this.link.sendControl({ t: 'bye' });
    this.reset();
    this.app.endMatch();
    this.app.showTitle();
  }

  pick(titan: TitanId): void {
    if (this.view.phase !== 'select' || this.view.myLocked || !this.titans.includes(titan)) return;
    this.view.myPick = titan;
    this.sendPick();
  }

  lock(on: boolean): void {
    const v = this.view;
    if (v.phase !== 'select' && v.phase !== 'stage') return;
    v.myLocked = on;
    this.sendPick();
    this.checkBothLocked();
  }

  chooseStage(stage: StageId | 'random'): void {
    if (this.view.role !== 'host' || this.view.phase !== 'stage') return;
    this.view.stage = stage;
    this.send({ t: 'stage', stage });
  }

  confirmStage(): void {
    const v = this.view;
    if (v.role !== 'host' || v.phase !== 'stage' || !v.myLocked || !v.peerLocked || !v.peerPick) return;
    const s = this.app.matchSettings();
    const stage =
      v.stage === 'random' ? this.stages[Math.floor(Math.random() * this.stages.length)]! : v.stage;
    const config: MatchConfig = {
      seed: Math.floor(Math.random() * 0x7fffffff) || 1,
      stage,
      mode: 'versus',
      slots: [
        { titan: v.myPick, controller: 'human' },
        { titan: v.peerPick, controller: 'human' },
      ],
      footwork: s.footwork,
      zdepth: s.zdepth,
      witness: false,
      pace: s.pace,
      roundSeconds: s.roundSeconds,
    };
    this.epoch = (this.epoch + 1) & 0xff;
    const delay = this.opts.forceDelay || delayFor(this.rtt.rtt, this.rtt.jitter);
    this.send({ t: 'start', epoch: this.epoch, delay, config });
    this.beginCountdown(config, delay);
  }

  rematch(): void {
    if (this.peerGone || !this.link) {
      this.fail(ERR.left);
      return;
    }
    this.meRematch = true;
    this.send({ t: 'rematch' });
    if (this.view.peerWantsRematch) this.enterSelect();
    else {
      this.setPhase('rematch');
      this.app.showOnline();
    }
  }

  resume(): void {
    this.view.leaveAsk = false;
    if (this.view.phase === 'match') this.app.showHud();
  }

  /** In a match: PAUSE asks whether to leave (the match keeps running: the other player is still playing). */
  askLeave(): void {
    if (this.view.phase !== 'match') return;
    this.view.leaveAsk = true;
    this.app.showOnline();
  }

  copyLink(): void {
    const link = this.view.link;
    if (!link) return;
    const done = (ok: boolean): void => {
      this.view.copied = ok;
      this.copiedUntil = this.now() + 2500;
    };
    try {
      void navigator.clipboard.writeText(link).then(
        () => done(true),
        () => done(false),
      );
    } catch {
      done(false);
    }
  }

  /** Download the last desync report as JSON (the player presses the key; nothing is sent anywhere). */
  saveLog(): void {
    if (!this.lastDesync) return;
    const blob = new Blob([JSON.stringify(this.lastDesync)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `adeuk-desync-${Date.now()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  /* ---------------------------------------------------------------------------------------------- *
   *  per frame
   * ---------------------------------------------------------------------------------------------- */
  update(): void {
    const v = this.view;
    const now = this.now();
    if (v.copied !== null && now > this.copiedUntil) v.copied = null;
    v.pingMs = this.rtt.rtt ?? (this.rtt.last !== null ? Math.round(this.rtt.last) : null);
    // before a match the delay shown is what the link would get now; from the countdown on, the agreed one
    if (v.phase !== 'match' && v.phase !== 'countdown')
      v.delay = this.driver?.lockstep.delay ?? delayFor(this.rtt.rtt, this.rtt.jitter);
    v.waiting = this.driver && !this.driver.freeRunning ? this.driver.stalled : 0;

    if (v.phase === 'countdown') {
      v.countdown = Math.max(0, (this.countdownEnd - now) / 1000);
      if (now >= this.countdownEnd) this.beginMatch();
    }
    if (v.phase === 'connecting' && this.joinDeadline && now > this.joinDeadline && !this.peerHello) {
      this.fail(this.opts.mode === 'local' || !this.link ? ERR.notfound : ERR.noconnect);
      return;
    }
    // the desync check runs in the lockstep; the session stops everything and reports
    const ds = this.driver?.lockstep.desync;
    if (ds && v.phase === 'match') {
      this.onDesync(ds, true);
      return;
    }
    this.watchdog(now);
    this.auto(now);
  }

  private watchdog(now: number): void {
    const v = this.view;
    const live =
      this.peerHello &&
      (v.phase === 'select' ||
        v.phase === 'stage' ||
        v.phase === 'countdown' ||
        v.phase === 'match' ||
        v.phase === 'rematch');
    if (!live) {
      v.reconnecting = 0;
      return;
    }
    // an online match that is over is decided: a silent peer there is only reading the results
    if (v.phase === 'match' && this.driver?.freeRunning && !this.link) return;
    const down = !this.link || this.link.state !== 'open' || now - this.lastHeard > SILENT_MS;
    if (!down) {
      this.downSince = 0;
      v.reconnecting = 0;
      return;
    }
    if (!this.downSince) this.downSince = now;
    // the transport still says it is up but the peer is silent: outside a running match that is a busy page (a slow
    // machine generating portraits or preparing the stage blocks its page for a while), not a lost connection, so it
    // gets longer. In a running match (the peer's inputs were flowing) the normal grace applies.
    const loading =
      this.link?.state === 'open' &&
      (v.phase !== 'match' || (!!this.driver && this.driver.lockstep.packetsIn === 0));
    const left = (loading ? LOAD_GRACE_MS : GRACE_MS) - (now - this.downSince);
    // (a loading peer shows as "waiting for opponent", not as a lost connection)
    v.reconnecting = loading ? 0 : Math.max(1, Math.ceil(left / 1000));
    if (left <= 0) {
      if (v.phase === 'match' && this.driver?.freeRunning) {
        // the match was over anyway: no error screen over the results, but no rematch either
        this.peerGone = true;
        v.reconnecting = 0;
        return;
      }
      this.fail(ERR.lost);
      return;
    }
    // WebRTC: the host rebuilds the peer connection through the room socket while the grace period runs
    if (
      this.opts.mode === 'worker' &&
      v.role === 'host' &&
      (!this.link || this.link.state === 'closed') &&
      now - this.lastRebuild > REBUILD_EVERY_MS &&
      this.signal?.open
    ) {
      this.lastRebuild = now;
      void this.startRtc();
    }
    if (this.opts.mode === 'worker' && !this.signal && now > this.signalRetryAt) {
      this.signalRetryAt = now + 2000;
      this.openSignal();
    }
  }

  /** Testing (`netai=N`): pick, lock, choose the stage by themselves. */
  private auto(now: number): void {
    if (this.opts.autoAi <= 0) return;
    const v = this.view;
    if (now < this.autoAt) return;
    if (v.phase === 'select' && !v.myLocked) {
      const want = this.opts.autoPick as TitanId | null;
      if (want && this.titans.includes(want)) this.pick(want);
      this.lock(true);
      this.autoAt = now + 300;
    } else if (v.phase === 'stage' && v.role === 'host') {
      const st = this.opts.autoStage as StageId | null;
      this.chooseStage(st && this.stages.includes(st) ? st : 'random');
      this.confirmStage();
    }
  }

  /* ---------------------------------------------------------------------------------------------- *
   *  links
   * ---------------------------------------------------------------------------------------------- */
  private setRoom(code: string): void {
    this.view.code = code;
    this.view.link = typeof location !== 'undefined' ? roomLink(code, location) : null;
  }

  private handlersFor(): LinkHandlers {
    // events from a replaced link are ignored (a reconnect makes a new one)
    let me: NetLink | null = null;
    const h: LinkHandlers & { bind(l: NetLink): void } = {
      bind: (l) => (me = l),
      fast: (b) => {
        if (me === this.link) this.onFast(b);
      },
      control: (m) => {
        if (me === this.link) this.onControl(m);
      },
      state: (s) => {
        if (me === this.link) this.onLinkState(s);
      },
    };
    this.pendingBind = h.bind;
    return h;
  }
  private pendingBind: ((l: NetLink) => void) | null = null;
  /** Signalling for a connection attempt whose link is still being built (guest side). */
  private early: RtcSignal[] = [];

  private useLink(l: NetLink): void {
    this.pendingBind?.(l);
    this.pendingBind = null;
    const old = this.link;
    this.link = l;
    if (old && old !== l) old.close();
    if (l.state === 'open') this.onLinkState('open');
  }

  private onLinkState(s: LinkState): void {
    if (s === 'open') {
      this.lastHeard = this.now();
      this.downSince = 0;
      if (!this.heartbeat && typeof window !== 'undefined')
        this.heartbeat = window.setInterval(() => this.beat(), HEARTBEAT_MS);
      if (!this.helloSent) {
        this.helloSent = true;
        this.send({ t: 'hello', build: buildId(), tuned: this.app.tuned(), titans: this.titans });
        if (this.view.phase === 'waiting') this.setPhase('connecting');
      }
    } else if (s === 'closed' && this.opts.mode === 'local') {
      // a BroadcastChannel only closes on a goodbye or a closed tab
      this.onPeerLeft();
    }
  }

  private beat(): void {
    const l = this.link;
    if (!l || l.state !== 'open') return;
    const now = this.now();
    if (now - this.lastPingAt >= PING_EVERY_MS) {
      this.lastPingAt = now;
      l.sendFast(encodePing(PKT_PING, ++this.pingId, now));
    }
    // keep the input lane alive while the loop is stalled or the tab is hidden (the peer may be missing a packet)
    if (this.driver && !this.driver.halted) this.driver.flush();
  }

  private onFast(b: Uint8Array): void {
    this.lastHeard = this.now();
    const type = b[0];
    if (type === PKT_INPUT) {
      this.driver?.receive(b);
    } else if (type === PKT_PING) {
      const p = decodePing(b);
      if (p) this.link?.sendFast(encodePing(PKT_PONG, p.id, p.sentMs));
    } else if (type === PKT_PONG) {
      const p = decodePing(b);
      if (p) this.rtt.add(this.now() - p.sentMs);
    }
  }

  private send(m: ControlMsg): void {
    this.link?.sendControl(m);
  }

  private onControl(m: ControlMsg): void {
    this.lastHeard = this.now();
    const v = this.view;
    switch (m.t) {
      case 'hello': {
        if (m.build !== buildId()) {
          this.send({ t: 'refuse', reason: 'build' });
          this.fail(ERR.build, `${buildId()} vs ${m.build}: reload both pages`);
          return;
        }
        if (m.tuned || this.app.tuned()) {
          this.send({ t: 'refuse', reason: 'tuned' });
          this.fail(ERR.tuned, 'reload the page that used the debug panel');
          return;
        }
        const theirs = new Set(m.titans);
        this.titans = this.titans.filter((t) => theirs.has(t));
        if (!this.titans.includes(v.myPick)) v.myPick = this.titans[0] ?? v.myPick;
        const first = !this.peerHello;
        this.peerHello = true;
        if (first) this.enterSelect();
        return;
      }
      case 'refuse':
        this.fail(m.reason === 'build' ? ERR.build : ERR.tuned);
        return;
      case 'pick':
        if ((TITAN_IDS as readonly string[]).includes(m.titan)) v.peerPick = m.titan as TitanId;
        v.peerLocked = m.locked;
        if (v.phase === 'stage' && !m.locked) this.setPhase('select');
        this.checkBothLocked();
        return;
      case 'stage':
        if (m.stage === 'random' || this.stages.includes(m.stage as StageId))
          v.stage = m.stage as StageId | 'random';
        return;
      case 'start': {
        if (v.role !== 'guest') return;
        const cfg = validConfig(m.config);
        if (!cfg) {
          this.fail(ERR.badrequest, 'the host sent a match this build cannot play');
          return;
        }
        this.epoch = m.epoch & 0xff;
        v.stage = cfg.stage;
        this.beginCountdown(cfg, Math.min(6, Math.max(2, Math.round(m.delay) || 3)));
        return;
      }
      case 'rematch':
        v.peerWantsRematch = true;
        if (this.meRematch) this.enterSelect();
        return;
      case 'desync':
        if (v.phase !== 'error')
          this.onDesync(
            this.driver?.lockstep.desync ?? {
              tick: m.tick,
              kind: m.kind === 'hash' ? 'hash' : 'checksum',
              local: m.remote,
              remote: m.local,
            },
            false,
          );
        return;
      case 'bye':
        this.onPeerLeft();
        return;
    }
  }

  private onPeerLeft(): void {
    this.peerGone = true;
    const v = this.view;
    if (v.phase === 'menu' || v.phase === 'code' || v.phase === 'error') return;
    if (v.phase === 'match' && this.driver?.freeRunning) return; // reading the results: REMATCH will say so
    this.fail(ERR.left);
  }

  private openSignal(): void {
    const v = this.view;
    if (!v.code || !v.role) return;
    const role = v.role;
    this.signal?.close();
    this.signal = new SignalSocket(this.opts.url, v.code, role, this.token, {
      joined: (token, peer) => {
        this.token = token;
        // relay credentials are minted for room members only, so the guest asks once it holds a seat
        if (!this.ice && v.code) this.ice = fetchIceServers(this.opts.url, v.code, token);
        if (role === 'host' && peer && this.link?.state !== 'open') void this.startRtc();
      },
      peer: (present) => {
        if (present && role === 'host' && this.link?.state !== 'open') void this.startRtc();
      },
      relay: (d) => {
        if (isRtcSignal(d)) void this.onRtcSignal(d);
      },
      error: (code) => this.failSignal(code),
      closed: () => {
        this.signal = null;
        this.signalRetryAt = this.now() + 1000;
      },
    });
  }

  private failSignal(code: SignalError): void {
    if (this.peerHello && code === 'network') {
      // the room socket dropped mid-session: the peer-to-peer link may well be fine; the watchdog retries
      this.signal = null;
      return;
    }
    this.fail(ERR[code] ?? ERR.network);
  }

  private async startRtc(): Promise<void> {
    const gen = ++this.gen;
    const iceServers = await (this.ice ?? Promise.resolve(STUN_ONLY));
    if (gen !== this.gen || this.view.phase === 'error' || this.view.phase === 'menu') return;
    const link = createRtcLink(
      { offerer: true, gen, iceServers, signal: (s) => this.signal?.send(s) },
      this.handlersFor(),
    );
    this.useLink(link);
  }

  private async onRtcSignal(s: RtcSignal): Promise<void> {
    const cur = this.link as Partial<RtcLink> | null;
    if (cur && cur.gen === s.gen && cur.handleSignal) {
      cur.handleSignal(s);
      return;
    }
    if (this.view.role === 'guest' && s.k === 'offer' && s.gen > this.gen) {
      this.gen = s.gen;
      this.early = [];
      const iceServers = await (this.ice ?? Promise.resolve(STUN_ONLY));
      if (s.gen !== this.gen) return;
      const link = createRtcLink(
        { offerer: false, gen: s.gen, iceServers, signal: (x) => this.signal?.send(x) },
        this.handlersFor(),
      );
      this.useLink(link);
      link.handleSignal(s);
      // candidates that arrived while the ICE servers were being fetched
      for (const e of this.early.splice(0)) if (e.gen === s.gen) link.handleSignal(e);
      return;
    }
    if (s.gen === this.gen && this.early.length < 200) this.early.push(s);
  }

  /* ---------------------------------------------------------------------------------------------- *
   *  session flow
   * ---------------------------------------------------------------------------------------------- */
  private sendPick(): void {
    this.send({ t: 'pick', titan: this.view.myPick, locked: this.view.myLocked });
  }

  private checkBothLocked(): void {
    const v = this.view;
    if (v.phase === 'select' && v.myLocked && v.peerLocked && v.peerPick) {
      this.setPhase('stage');
      if (v.role === 'host') this.send({ t: 'stage', stage: v.stage });
    } else if (v.phase === 'stage' && (!v.myLocked || !v.peerLocked)) this.setPhase('select');
  }

  private enterSelect(): void {
    const v = this.view;
    if (this.driver) this.driver.halted = true;
    this.driver = null;
    this.config = null;
    this.meRematch = false;
    v.peerWantsRematch = false;
    v.myLocked = false;
    v.peerLocked = false;
    v.leaveAsk = false;
    v.desync = null;
    this.joinDeadline = 0;
    this.setPhase('select');
    this.app.endMatch();
    this.app.showOnline();
    this.autoAt = this.now() + 400;
    this.sendPick();
  }

  private beginCountdown(config: MatchConfig, delay: number): void {
    this.config = config;
    this.view.delay = delay;
    this.view.leaveAsk = false;
    this.countdownEnd = this.now() + COUNTDOWN_MS;
    this.view.countdown = COUNTDOWN_MS / 1000;
    this.pendingDelay = delay;
    this.setPhase('countdown');
    this.app.prepareStage(config.stage);
    this.app.showOnline();
  }
  private pendingDelay = 3;

  private beginMatch(): void {
    const cfg = this.config;
    if (!cfg) return;
    const localSlot: 0 | 1 = this.view.role === 'host' ? 0 : 1;
    const ls = new Lockstep(localSlot, this.pendingDelay, this.epoch);
    const driver = new NetMatchDriver(ls, (b) => this.link?.sendFast(b));
    this.driver = driver;
    this.setPhase('match');
    this.app.startOnline(cfg, driver, localSlot, this.opts.autoAi);
  }

  private onDesync(info: DesyncInfo, detectedHere: boolean): void {
    const ls = this.driver?.lockstep;
    const report = {
      build: buildId(),
      role: this.view.role,
      config: this.config,
      desync: info,
      detectedHere,
      dump: ls ? ls.dump() : null,
    };
    this.lastDesync = report;
    console.error(
      `ADEUK netplay DESYNC at tick ${info.tick} (${info.kind}): local ${info.local.toString(16)} remote ${info.remote.toString(16)}`,
    );
    console.error(
      'ADEUK netplay desync report (replay: npx tsx tools/netplay/desync-replay.ts <file>):',
      report,
    );
    if (detectedHere) this.send({ t: 'desync', ...info });
    this.view.desync = info;
    this.fail(ERR.desync, `tick ${info.tick}  ${info.kind}  ${hex(info.local)} / ${hex(info.remote)}`);
  }

  private fail(e: { en: string; ko: string }, detail?: string): void {
    if (this.driver) this.driver.halted = true;
    this.view.error = { en: e.en, ko: e.ko, detail };
    this.view.leaveAsk = false;
    this.view.reconnecting = 0;
    this.setPhase('error');
    this.stopTransport();
    this.app.showOnline();
  }

  private stopTransport(): void {
    if (this.heartbeat) window.clearInterval(this.heartbeat);
    this.heartbeat = 0;
    this.link?.close();
    this.link = null;
    this.signal?.close();
    this.signal = null;
  }

  /** Close everything and go back to the ONLINE menu state. */
  private reset(): void {
    if (this.driver) this.driver.halted = true;
    this.stopTransport();
    this.driver = null;
    this.config = null;
    this.token = null;
    this.ice = null;
    this.helloSent = false;
    this.peerHello = false;
    this.meRematch = false;
    this.peerGone = false;
    this.downSince = 0;
    this.joinDeadline = 0;
    this.rtt.clear();
    const pick = this.view?.myPick;
    Object.assign(this.view, this.freshView());
    if (pick && this.titans.includes(pick)) this.view.myPick = pick;
  }
}

const STUN_ONLY: RTCIceServer[] = [{ urls: 'stun:stun.cloudflare.com:3478' }];

const hex = (n: number): string => (n >>> 0).toString(16).padStart(8, '0');

/** The host's config, checked before this build runs it (ids it knows, sane numbers, two human slots). */
export function validConfig(raw: unknown): MatchConfig | null {
  const c = raw as Partial<MatchConfig> | null;
  if (!c || typeof c !== 'object') return null;
  const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  if (!num(c.seed) || !(STAGE_IDS as readonly string[]).includes(c.stage as string)) return null;
  if (!Array.isArray(c.slots) || c.slots.length !== 2) return null;
  for (const s of c.slots)
    if (!s || !(TITAN_IDS as readonly string[]).includes(s.titan as string) || s.controller !== 'human')
      return null;
  if (!num(c.pace) || !num(c.roundSeconds)) return null;
  if (c.footwork !== 'classic' && c.footwork !== 'orbit') return null;
  return {
    seed: c.seed,
    stage: c.stage!,
    mode: 'versus',
    slots: [
      { titan: c.slots[0]!.titan, controller: 'human' },
      { titan: c.slots[1]!.titan, controller: 'human' },
    ],
    footwork: c.footwork,
    zdepth: !!c.zdepth,
    witness: false,
    pace: c.pace,
    roundSeconds: c.roundSeconds,
  };
}
