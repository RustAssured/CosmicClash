import type { InputFrame, InputSource } from '@/contracts';
import { computeAutoAssignment } from './assign';
import { defaultBindingsFor } from './bindings';
import { StickCapture, rotationFromUp } from './deadzone';
import { KeyboardDevice, PadDevice, type Device } from './device';
import { KEY_LAYOUTS, isGameKey, keyLabel } from './keyboard';
import { backButton, confirmButton, defaultPadButton, padButtonLabel, resolveFamily } from './labels';
import { describeRef, detectPress } from './mapping';
import { NAV, NavRepeater } from './nav';
import { detectProfile, type DeviceProfile } from './profiles';
import { RumbleGate, hasRumble, playRumble } from './rumble';
import {
  browserStore,
  loadPersisted,
  mergeSettings,
  savePersisted,
  type DeviceOverrides,
  type PersistedInput,
} from './storage';
import {
  emptyNav,
  type Action,
  type CalibrationState,
  type CaptureState,
  type DeviceInfo,
  type GlyphFamily,
  type HidStatus,
  type InputManager,
  type InputSettings,
  type KeyValueStore,
  type LiveDevice,
  type NavFrame,
  type PadLike,
  type RawRef,
} from './types';
import { Pad } from './types';
import {
  HidPad,
  NINTENDO_VENDOR,
  PRO_PRODUCT,
  hidSupported,
  type HidDeviceLike,
  type HidLike,
} from './webhid';

export interface InputManagerOptions {
  /** Event target for gamepad/keyboard events (default `window`). */
  window?: EventTarget;
  /** Pad source (default `navigator.getGamepads`). Tests and the e2e harness inject fakes. */
  getGamepads?: () => ArrayLike<PadLike | null>;
  /** Storage: omit for `localStorage` (guarded), `null` for none. */
  storage?: KeyValueStore | null;
  /** Monotonic clock in ms (default `performance.now`). */
  now?: () => number;
  userAgent?: string;
  /** `navigator.hid`, or null to disable WebHID. */
  hid?: HidLike | null;
  /** Listen to the keyboard (default true). */
  keyboard?: boolean;
}

const CAPTURE_TIMEOUT_MS = 12_000;
const HID_STALL_MS = 3_000;
const STALE_LATCH_MS = 100;

interface NavScope {
  repeater: NavRepeater;
  prevButtons: number;
  frame: NavFrame;
}
const newScope = (): NavScope => ({ repeater: new NavRepeater(), prevButtons: 0, frame: emptyNav() });

export function createInputManager(opts: InputManagerOptions = {}): InputManager {
  return new Manager(opts);
}

class Manager implements InputManager {
  private readonly target: EventTarget | null;
  private readonly getPads: () => ArrayLike<PadLike | null>;
  private readonly store: KeyValueStore | null;
  private readonly clock: () => number;
  private readonly ua: string;
  private readonly hidApi: HidLike | null;
  private readonly wantKeyboard: boolean;

  private persisted: PersistedInput;
  private cfg: InputSettings;
  private readonly getCfg = (): InputSettings => this.cfg;

  private readonly kb: KeyboardDevice[];
  private readonly pads = new Map<number, PadDevice>();
  private readonly padOrder: string[] = [];
  private hidPad: HidPad | null = null;
  private hidDevice: PadDevice | null = null;
  private hidState: HidStatus;
  private hidSeenAt = 0;

  private assigned: [string | null, string | null] = [null, null];
  private manual: [string | null, string | null] = [null, null];
  private lost: [boolean, boolean] = [false, false];
  private lastActiveId: string | null = null;

  private readonly gates = new Map<string, RumbleGate>();
  private readonly devListeners = new Set<() => void>();
  private readonly activityListeners = new Set<(d: DeviceInfo) => void>();
  private readonly settingsListeners = new Set<(s: Readonly<InputSettings>) => void>();
  private activityQueue: DeviceInfo[] = [];

  private lastPollNow = -Infinity;
  private lastTick = -1;
  /** Clock time of the last tick-time sample; a stale value means the sim is not running (menus). */
  private lastSampleAt = -Infinity;
  private tickPolled: [boolean, boolean] = [false, false];
  private prevHeld: [number, number] = [0, 0];
  private readonly stickTmp = { x: 0, y: 0 };
  private readonly prevDown = new Map<string, boolean>();

  private readonly scopes: [NavScope, NavScope, NavScope] = [newScope(), newScope(), newScope()];
  private readonly emptyFrame: NavFrame = emptyNav();

  capture: CaptureState = { status: 'idle', kind: 'binding', action: null, device: null, result: null };
  private captureRest: number[] = [];
  private captureArmed = false;
  private captureStart = 0;
  private captureSuppress = 0;

  calibration: CalibrationState = {
    phase: 'idle',
    device: null,
    progress: 0,
    leftExtent: null,
    rightExtent: null,
  };
  private calLeft: StickCapture | null = null;
  private calRight: StickCapture | null = null;

  private readonly sources: [InputSource, InputSource];
  private attached = false;
  private readonly cleanups: (() => void)[] = [];
  private readonly liveCache = new Map<string, LiveDevice>();

  constructor(o: InputManagerOptions) {
    this.target = o.window ?? (typeof window !== 'undefined' ? window : null);
    this.getPads =
      o.getGamepads ??
      ((): ArrayLike<PadLike | null> => {
        const nav = typeof navigator !== 'undefined' ? navigator : undefined;
        return nav && typeof nav.getGamepads === 'function'
          ? (nav.getGamepads() as ArrayLike<PadLike | null>)
          : [];
      });
    this.store = o.storage === undefined ? browserStore() : o.storage;
    this.clock =
      o.now ?? ((): number => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
    this.ua = o.userAgent ?? (typeof navigator !== 'undefined' ? navigator.userAgent : '');
    this.hidApi =
      o.hid === undefined
        ? typeof navigator !== 'undefined' && hidSupported(navigator as { hid?: unknown })
          ? ((navigator as unknown as { hid: HidLike }).hid as HidLike)
          : null
        : o.hid;
    this.wantKeyboard = o.keyboard !== false;
    this.hidState = this.hidApi ? 'idle' : 'unsupported';

    this.persisted = loadPersisted(this.store);
    this.cfg = mergeSettings(this.persisted.settings);

    this.kb = KEY_LAYOUTS.map((layout) => {
      const kd = new KeyboardDevice(
        {
          id: layout.id,
          kind: 'keyboard',
          name: layout.name,
          profile: 'keyboard',
          family: 'keyboard',
          vendor: null,
          product: null,
          mapping: 'keyboard',
          layoutId: layout.id,
          rawId: layout.id,
          index: -1,
          connected: true,
          slot: null,
          hasRumble: false,
          profileKey: layout.profileKey,
        },
        layout,
      );
      const ov = this.persisted.keyboards[layout.id]?.keys;
      if (ov) kd.keys.overrides = { ...ov };
      return kd;
    });

    this.sources = [this.makeSource(0), this.makeSource(1)];
    this.recomputeAssignment(false);
  }

  /* ---------------------------------------------------------------------------------------------- *
   *  lifecycle
   * ---------------------------------------------------------------------------------------------- */
  attach(target?: Window): void {
    if (this.attached) return;
    this.attached = true;
    const t: EventTarget | null = target ?? this.target;
    if (!t) return;
    const on = (type: string, fn: (e: Event) => void): void => {
      t.addEventListener(type, fn);
      this.cleanups.push(() => t.removeEventListener(type, fn));
    };
    on('gamepadconnected', () => this.scan());
    on('gamepaddisconnected', () => this.scan());
    if (this.wantKeyboard) {
      on('keydown', (e) => this.onKey(e as KeyboardEvent, true));
      on('keyup', (e) => this.onKey(e as KeyboardEvent, false));
      on('blur', () => this.releaseKeys());
    }
    if (typeof document !== 'undefined' && t === (typeof window !== 'undefined' ? window : null)) {
      const vis = (): void => {
        if (document.hidden) this.releaseKeys();
      };
      document.addEventListener('visibilitychange', vis);
      this.cleanups.push(() => document.removeEventListener('visibilitychange', vis));
    }
    this.scan();
    if (this.persisted.hid && this.hidApi) void this.autoConnectHid();
  }

  detach(): void {
    for (const c of this.cleanups.splice(0)) c();
    this.attached = false;
    this.releaseKeys();
    if (this.hidPad) void this.hidPad.stop();
  }

  private releaseKeys(): void {
    for (const k of this.kb) k.keys.releaseAll();
  }

  private onKey(e: KeyboardEvent, down: boolean): void {
    const code = e.code;
    if (!code) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const tgt = e.target as { tagName?: string } | null;
    const tag = tgt?.tagName?.toUpperCase();
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (isGameKey(code) && typeof e.preventDefault === 'function') e.preventDefault();
    for (const k of this.kb) {
      if (!k.keys.owns(code)) continue;
      if (down) {
        if (!e.repeat) k.keys.keyDown(code);
      } else k.keys.keyUp(code);
    }
    // Capture / activation want keys that are not part of any layout too.
    if (down && !e.repeat) this.looseKeys.push(code);
  }
  private looseKeys: string[] = [];

  /* ---------------------------------------------------------------------------------------------- *
   *  devices
   * ---------------------------------------------------------------------------------------------- */
  private deviceById(id: string | null): Device | null {
    if (!id) return null;
    if (id === 'kb1') return this.kb[0]!;
    if (id === 'kb2') return this.kb[1]!;
    if (id === 'hid:0') return this.hidDevice;
    if (id.startsWith('pad:')) return this.pads.get(parseInt(id.slice(4), 10)) ?? null;
    return null;
  }

  private allDevices(): Device[] {
    const out: Device[] = [...this.kb];
    for (const i of [...this.pads.keys()].sort((a, b) => a - b)) out.push(this.pads.get(i)!);
    if (this.hidDevice) out.push(this.hidDevice);
    return out;
  }

  devices(): readonly DeviceInfo[] {
    return this.allDevices().map((d) => d.info);
  }

  private hidActive(): boolean {
    return this.hidState === 'connected' && this.hidDevice !== null;
  }

  private createPad(p: PadLike): PadDevice {
    const profile: DeviceProfile = detectProfile(p.id, p.mapping, this.ua);
    const info: DeviceInfo = {
      id: `pad:${p.index}`,
      kind: 'gamepad',
      name: profile.name,
      profile: profile.kind,
      family: profile.family,
      vendor: profile.vendor,
      product: profile.product,
      mapping: p.mapping || 'non-standard',
      layoutId: profile.layout.id,
      rawId: p.id,
      index: p.index,
      connected: true,
      slot: null,
      hasRumble: hasRumble(p),
      profileKey: profile.key,
    };
    const dev = new PadDevice(info, profile, this.persisted.devices[profile.key] ?? {}, this.getCfg);
    return dev;
  }

  /** Re-read the pads and refresh every device. Cheap; called per frame and per sim tick. */
  private scan(): void {
    let list: ArrayLike<PadLike | null>;
    try {
      list = this.getPads();
    } catch {
      list = [];
    }
    const seen = new Set<number>();
    let changed = false;
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      if (!p || !p.connected) continue;
      seen.add(p.index);
      let dev = this.pads.get(p.index);
      if (dev && dev.info.rawId !== p.id) {
        // A different controller took over this index.
        this.pads.delete(p.index);
        this.forgetPad(dev);
        dev = undefined;
        changed = true;
      }
      if (!dev) {
        dev = this.createPad(p);
        this.pads.set(p.index, dev);
        this.padOrder.push(dev.info.id);
        changed = true;
      }
      dev.info.hasRumble = hasRumble(p);
      dev.refresh(p);
    }
    for (const [idx, dev] of this.pads) {
      if (!seen.has(idx)) {
        this.pads.delete(idx);
        this.forgetPad(dev);
        dev.clear();
        changed = true;
      }
    }
    if (this.hidPad && this.hidDevice) {
      this.hidDevice.refresh(this.hidPad.pad);
      const now = this.clock();
      if (this.hidPad.receiving) this.hidSeenAt = now;
      else if (now - this.hidSeenAt > HID_STALL_MS && this.hidState === 'connected') {
        // The pad stopped talking (unplugged, or another backend took it): fall back to the Gamepad API silently.
        void this.dropHid('error');
        changed = true;
      }
    }
    for (const k of this.kb) k.refresh();
    if (changed) this.deviceSetChanged();
  }

  private forgetPad(dev: PadDevice): void {
    const i = this.padOrder.indexOf(dev.info.id);
    if (i >= 0) this.padOrder.splice(i, 1);
    this.gates.delete(dev.info.id);
    this.prevDown.delete(dev.info.id);
    this.liveCache.delete(dev.info.id);
    for (const s of [0, 1] as const) {
      if (this.manual[s] === dev.info.id) {
        this.manual[s] = null;
        this.lost[s] = true;
      }
      if (this.assigned[s] === dev.info.id) this.lost[s] = true;
    }
    if (this.lastActiveId === dev.info.id) this.lastActiveId = null;
  }

  private deviceSetChanged(): void {
    this.recomputeAssignment(true);
  }

  private visiblePadIds(): string[] {
    const ids = this.padOrder.filter((id) => {
      if (!this.hidActive()) return true;
      const d = this.deviceById(id);
      return !(d instanceof PadDevice && d.profile.kind === 'switch-pro');
    });
    if (this.hidDevice && this.hidActive()) ids.unshift('hid:0');
    return ids;
  }

  private recomputeAssignment(notify: boolean): void {
    const auto = computeAutoAssignment(this.visiblePadIds(), this.manual);
    const changed = auto[0] !== this.assigned[0] || auto[1] !== this.assigned[1];
    this.assigned = auto;
    for (const s of [0, 1] as const) if (auto[s]) this.lost[s] = false;
    for (const d of this.allDevices()) d.info.slot = null;
    if (auto[0]) {
      const d = this.deviceById(auto[0]);
      if (d) d.info.slot = 0;
    }
    if (auto[1]) {
      const d = this.deviceById(auto[1]);
      if (d) d.info.slot = 1;
    }
    if (notify || changed) for (const cb of [...this.devListeners]) cb();
  }

  assignment(): readonly [string | null, string | null] {
    return this.assigned;
  }

  assign(slot: 0 | 1, deviceId: string | null): void {
    const other = slot === 0 ? 1 : 0;
    if (deviceId !== null && !this.deviceById(deviceId)) return;
    if (deviceId !== null && this.assigned[other] === deviceId) {
      // Taking the other player's device: they get ours (a swap) so nobody is left without one.
      this.manual[other] = this.assigned[slot];
    }
    this.manual[slot] = deviceId;
    this.recomputeAssignment(true);
  }

  swapSlots(): void {
    const a = this.assigned[0];
    const b = this.assigned[1];
    this.manual = [b, a];
    this.recomputeAssignment(true);
  }

  autoAssign(): void {
    this.manual = [null, null];
    this.recomputeAssignment(true);
  }

  slotLost(slot: 0 | 1): boolean {
    return this.lost[slot];
  }

  onDevices(cb: () => void): () => void {
    this.devListeners.add(cb);
    return () => void this.devListeners.delete(cb);
  }

  onActivity(cb: (d: DeviceInfo) => void): () => void {
    this.activityListeners.add(cb);
    return () => void this.activityListeners.delete(cb);
  }

  drainActivity(out: DeviceInfo[]): void {
    for (const d of this.activityQueue) out.push(d);
    this.activityQueue.length = 0;
  }

  lastActiveDevice(): DeviceInfo | null {
    return this.deviceById(this.lastActiveId)?.info ?? null;
  }

  /* ---------------------------------------------------------------------------------------------- *
   *  per-frame poll: nav, activity, capture, calibration
   * ---------------------------------------------------------------------------------------------- */
  poll(nowMs?: number): void {
    const now = nowMs ?? this.clock();
    // Idempotent per frame: the app and the UI may both call poll() in one frame.
    if (Math.abs(now - this.lastPollNow) < 3) return;
    this.lastPollNow = now;
    // Sub-tick taps are latched for the sim; with no sim running (menus) nothing will consume them, and a stale latch
    // would surface as a phantom button press on the first tick of the next match.
    if (now - this.lastSampleAt > STALE_LATCH_MS) for (const d of this.allDevices()) d.dropLatch();
    this.scan();

    const captured = this.stepCapture(now);
    this.stepCalibration();

    // activity ("press any button") + which device is the active one for prompts
    const anyFresh: Record<string, boolean> = {};
    for (const d of this.allDevices()) {
      let fresh = false;
      if (d instanceof KeyboardDevice) {
        fresh = d.keys.fresh.length > 0;
        d.keys.fresh.length = 0;
      } else {
        const down = d.anyDown();
        fresh = down && !this.prevDown.get(d.info.id);
        this.prevDown.set(d.info.id, down);
      }
      if (fresh) {
        anyFresh[d.info.id] = true;
        this.lastActiveId = d.info.id;
        if (!captured) {
          this.activityQueue.push(d.info);
          for (const cb of [...this.activityListeners]) cb(d.info);
        }
      }
    }
    this.looseKeys.length = 0;

    this.buildNav(now, anyFresh, captured);
  }

  private buildNav(now: number, anyFresh: Record<string, boolean>, suppress: boolean): void {
    const all = this.allDevices();
    const dirsFor = (which: 0 | 1 | 'any'): { dirs: number; btn: number; fresh: boolean } => {
      let dirs = 0;
      let btn = 0;
      let fresh = false;
      const add = (d: Device | null): void => {
        if (!d) return;
        dirs |= d.navDirs();
        btn |= d.navButtons(this.cfg);
        if (anyFresh[d.info.id]) fresh = true;
      };
      if (which === 'any') for (const d of all) add(d);
      else add(this.deviceById(this.assigned[which]));
      return { dirs, btn, fresh };
    };
    const which: (0 | 1 | 'any')[] = [0, 1, 'any'];
    for (let i = 0; i < 3; i++) {
      const sc = this.scopes[i]!;
      const f = sc.frame;
      if (suppress || this.capture.status === 'waiting') {
        Object.assign(f, this.emptyFrame);
        sc.repeater.step(now, 0);
        sc.prevButtons = dirsFor(which[i]!).btn;
        continue;
      }
      const { dirs, btn, fresh } = dirsFor(which[i]!);
      const fire = sc.repeater.step(now, dirs);
      f.up = (fire & NAV.UP) !== 0;
      f.down = (fire & NAV.DOWN) !== 0;
      f.left = (fire & NAV.LEFT) !== 0;
      f.right = (fire & NAV.RIGHT) !== 0;
      const edge = btn & ~sc.prevButtons;
      f.confirm = (edge & 1) !== 0;
      f.back = (edge & 2) !== 0;
      f.start = (edge & 4) !== 0;
      f.tab = (edge & 8) !== 0;
      f.any = fresh;
      f.heldConfirm = (btn & 1) !== 0;
      f.heldBack = (btn & 2) !== 0;
      sc.prevButtons = btn;
    }
  }

  nav(which: 0 | 1 | 'any' = 'any'): Readonly<NavFrame> {
    return this.scopes[which === 'any' ? 2 : which]!.frame;
  }

  /* ---------------------------------------------------------------------------------------------- *
   *  tick-time sources
   * ---------------------------------------------------------------------------------------------- */
  private makeSource(slot: 0 | 1): InputSource {
    return {
      kind: 'human',
      poll: (tick: number, out: InputFrame): void => this.sampleSlot(slot, tick, out),
    };
  }

  /** Sample the slot's device AT TICK TIME. Edges are per tick; a tap shorter than a tick is latched, not lost. */
  private sampleSlot(slot: 0 | 1, tick: number, out: InputFrame): void {
    if (tick !== this.lastTick) {
      this.lastTick = tick;
      this.tickPolled[0] = false;
      this.tickPolled[1] = false;
      this.scan();
    } else if (this.tickPolled[slot]) {
      this.scan();
    }
    this.tickPolled[slot] = true;
    this.lastSampleAt = this.clock();

    const dev = this.deviceById(this.assigned[slot]);
    if (!dev) {
      out.moveX = 0;
      out.moveY = 0;
      out.held = 0;
      out.pressed = 0;
      out.released = this.prevHeld[slot];
      this.prevHeld[slot] = 0;
      return;
    }
    const held = dev.takeSample(this.stickTmp);
    const prev = this.prevHeld[slot];
    out.moveX = this.stickTmp.x;
    out.moveY = this.stickTmp.y;
    out.held = held;
    out.pressed = held & ~prev;
    out.released = prev & ~held;
    this.prevHeld[slot] = held;
  }

  source(slot: 0 | 1): InputSource {
    return this.sources[slot];
  }

  /* ---------------------------------------------------------------------------------------------- *
   *  rumble
   * ---------------------------------------------------------------------------------------------- */
  rumble(slot: 0 | 1, strong: number, weak: number, ms: number): void {
    const id = this.assigned[slot];
    if (id) this.rumbleDevice(id, strong, weak, ms);
  }

  rumbleDevice(deviceId: string, strong: number, weak: number, ms: number): void {
    const dev = this.deviceById(deviceId);
    if (!dev || dev instanceof KeyboardDevice) return;
    const k = this.cfg.rumble;
    if (k <= 0) return;
    const peak = Math.max(strong, weak) * k;
    let gate = this.gates.get(dev.info.id);
    if (!gate) {
      gate = new RumbleGate();
      this.gates.set(dev.info.id, gate);
    }
    if (!gate.admit(this.clock(), peak, ms)) return;
    if (dev === this.hidDevice && this.hidPad) {
      this.hidPad.rumble(strong * k, weak * k);
      return;
    }
    if (dev instanceof PadDevice) playRumble(dev.pad, strong * k, weak * k, ms);
  }

  /* ---------------------------------------------------------------------------------------------- *
   *  settings
   * ---------------------------------------------------------------------------------------------- */
  get settings(): Readonly<InputSettings> {
    return this.cfg;
  }

  updateSettings(patch: Partial<InputSettings>): void {
    this.cfg = mergeSettings({ ...this.cfg, ...patch });
    this.persisted.settings = { ...this.cfg };
    this.save();
    for (const cb of [...this.settingsListeners]) cb(this.cfg);
  }

  onSettings(cb: (s: Readonly<InputSettings>) => void): () => void {
    this.settingsListeners.add(cb);
    return () => void this.settingsListeners.delete(cb);
  }

  private save(): void {
    savePersisted(this.store, this.persisted);
  }

  private overridesFor(dev: PadDevice): DeviceOverrides {
    let ov = this.persisted.devices[dev.profile.key];
    if (!ov) {
      ov = {};
      this.persisted.devices[dev.profile.key] = ov;
    }
    // All devices of one model share the record, and the live device points at it.
    dev.overrides = ov;
    for (const other of this.pads.values()) if (other.profile.key === dev.profile.key) other.overrides = ov;
    return ov;
  }

  /* ---------------------------------------------------------------------------------------------- *
   *  labels
   * ---------------------------------------------------------------------------------------------- */
  familyOf(where: 0 | 1 | 'any' | string): GlyphFamily {
    let d: Device | null;
    if (where === 0 || where === 1) d = this.deviceById(this.assigned[where]);
    else if (where === 'any') d = this.deviceById(this.lastActiveId);
    else d = this.deviceById(where);
    return d ? d.info.family : 'nintendo';
  }

  promptFamily(): GlyphFamily {
    const last = this.deviceById(this.lastActiveId);
    let fam: GlyphFamily | null = last && last.info.kind !== 'keyboard' ? last.info.family : null;
    if (!fam) {
      const firstPad = this.padOrder.length ? this.deviceById(this.padOrder[0]!) : null;
      fam = firstPad ? firstPad.info.family : null;
    }
    return resolveFamily(this.cfg.labelMode, fam);
  }

  private effFamily(d: Device | null): GlyphFamily {
    return resolveFamily(this.cfg.labelMode, d && d.info.kind !== 'keyboard' ? d.info.family : null);
  }

  private labelDevice(id: string | null): Device | null {
    return this.deviceById(id) ?? this.deviceById(this.lastActiveId);
  }

  actionLabel(deviceId: string | null, action: Action): string {
    const d = this.labelDevice(deviceId);
    if (d instanceof KeyboardDevice) {
      const k = d.keys.keysFor(action)[0];
      return k ? keyLabel(k) : '-';
    }
    const fam = this.effFamily(d);
    if (d instanceof PadDevice) {
      const refs = d.overrides.bindings?.[action];
      if (refs && refs.length) return this.labelOfRef(d, fam, refs[0]!);
      return padButtonLabel(fam, defaultPadButton(d.profile.kind, action));
    }
    return padButtonLabel(fam, defaultBindingsFor('switch-pro')[action][0]!);
  }

  private labelOfRef(d: PadDevice, fam: GlyphFamily, ref: RawRef): string {
    const layout = d.profile.layout;
    if (ref.k === 'h') {
      const map = { u: Pad.UP, d: Pad.DOWN, l: Pad.LEFT, r: Pad.RIGHT } as const;
      return padButtonLabel(fam, map[ref.d]);
    }
    if (ref.k === 'b') {
      for (const c of Object.keys(layout.buttons)) {
        const src = layout.buttons[Number(c)];
        if (src === ref.i || (Array.isArray(src) && src.includes(ref.i)))
          return padButtonLabel(fam, Number(c));
      }
    }
    return describeRef(ref).toUpperCase();
  }

  confirmLabel(deviceId: string | null): string {
    const d = this.labelDevice(deviceId);
    if (d instanceof KeyboardDevice) return d.info.id === 'kb2' ? 'ENTER' : 'SPACE';
    const fam = this.effFamily(d);
    return padButtonLabel(fam, confirmButton(fam, this.cfg.confirmMode));
  }

  backLabel(deviceId: string | null): string {
    const d = this.labelDevice(deviceId);
    if (d instanceof KeyboardDevice) return d.info.id === 'kb2' ? 'BKSP' : 'K';
    const fam = this.effFamily(d);
    return padButtonLabel(fam, backButton(fam, this.cfg.confirmMode));
  }

  /* ---------------------------------------------------------------------------------------------- *
   *  Controller Check: live views, remap, calibration, rotation
   * ---------------------------------------------------------------------------------------------- */
  live(deviceId: string): LiveDevice | null {
    const d = this.deviceById(deviceId);
    if (!d) return null;
    let lv = this.liveCache.get(deviceId);
    if (!lv) {
      lv = {
        info: d.info,
        rawButtons: [],
        rawAxes: [],
        canon: new Float32Array(20),
        rawLeft: [0, 0],
        rawRight: [0, 0],
        left: [0, 0],
        right: [0, 0],
        actions: 0,
        hat: null,
        deadzone: this.cfg.deadzone,
        hasCalibration: false,
        rotation: 0,
        bindings: {},
        custom: [],
      };
      this.liveCache.set(deviceId, lv);
    }
    lv.info = d.info;
    lv.actions = d.actions;
    lv.deadzone = this.cfg.deadzone;
    if (d instanceof PadDevice && d.pad) {
      const p = d.pad;
      lv.rawButtons.length = p.buttons.length;
      for (let i = 0; i < p.buttons.length; i++) lv.rawButtons[i] = p.buttons[i]!.value;
      lv.rawAxes.length = p.axes.length;
      for (let i = 0; i < p.axes.length; i++) lv.rawAxes[i] = p.axes[i]!;
      lv.canon.set(d.state.buttons);
      lv.rawLeft[0] = d.state.lx;
      lv.rawLeft[1] = d.state.ly;
      lv.rawRight[0] = d.state.rx;
      lv.rawRight[1] = d.state.ry;
      lv.left[0] = d.leftX;
      lv.left[1] = d.leftY;
      lv.right[0] = d.rightX;
      lv.right[1] = d.rightY;
      lv.hat = d.currentHat;
      lv.hasCalibration = d.calL !== null || d.calR !== null;
      lv.rotation = d.rotation;
      lv.bindings = d.overrides.bindings ?? {};
      lv.custom = Object.keys(lv.bindings) as Action[];
    } else if (d instanceof KeyboardDevice) {
      lv.rawButtons.length = 0;
      lv.rawAxes.length = 0;
      lv.canon.fill(0);
      lv.left[0] = lv.rawLeft[0] = d.moveX;
      lv.left[1] = lv.rawLeft[1] = d.moveY;
      lv.right[0] = lv.right[1] = lv.rawRight[0] = lv.rawRight[1] = 0;
      lv.hat = null;
      lv.hasCalibration = false;
      lv.rotation = 0;
      lv.bindings = {};
      lv.custom = Object.keys(d.keys.overrides) as Action[];
    }
    return lv;
  }

  beginCapture(deviceId: string, action: Action): void {
    const d = this.deviceById(deviceId);
    if (!d) return;
    this.cancelCalibration();
    this.capture = { status: 'waiting', kind: 'binding', action, device: deviceId, result: null };
    this.startCapture(d);
  }

  beginRotationWizard(deviceId: string): void {
    const d = this.deviceById(deviceId);
    if (!(d instanceof PadDevice)) return;
    this.cancelCalibration();
    this.capture = { status: 'waiting', kind: 'rotation', action: null, device: deviceId, result: null };
    this.startCapture(d);
  }

  private startCapture(d: Device): void {
    this.captureArmed = false;
    this.captureStart = this.clock();
    this.captureRest = d instanceof PadDevice && d.pad ? Array.from(d.pad.axes) : [];
    if (d instanceof KeyboardDevice) d.keys.fresh.length = 0;
    this.looseKeys.length = 0;
  }

  cancelCapture(): void {
    if (this.capture.status === 'waiting')
      this.capture = { ...this.capture, status: 'cancelled', result: null };
  }

  ackCapture(): void {
    if (this.capture.status !== 'waiting')
      this.capture = { status: 'idle', kind: 'binding', action: null, device: null, result: null };
  }

  private finishCapture(result: string): void {
    this.capture = { ...this.capture, status: 'done', result };
    this.captureSuppress = 2;
  }

  /** Returns true if input this poll was consumed by capture (so menus ignore it). */
  private stepCapture(now: number): boolean {
    if (this.captureSuppress > 0 && this.capture.status !== 'waiting') {
      this.captureSuppress--;
      return true;
    }
    if (this.capture.status !== 'waiting') return false;
    if (now - this.captureStart > CAPTURE_TIMEOUT_MS) {
      this.cancelCapture();
      return true;
    }
    const d = this.deviceById(this.capture.device);
    if (!d) {
      this.cancelCapture();
      return true;
    }
    if (d instanceof KeyboardDevice) {
      for (const code of this.looseKeys) {
        if (code === 'Escape') {
          this.cancelCapture();
          return true;
        }
        if (this.capture.kind === 'binding' && this.capture.action) {
          const a = this.capture.action;
          const rec = (this.persisted.keyboards[d.keys.layout.id] ??= { keys: {} });
          rec.keys = { ...(rec.keys ?? {}), [a]: [code] };
          d.keys.overrides = { ...d.keys.overrides, [a]: [code] };
          this.save();
          this.finishCapture(keyLabel(code));
          return true;
        }
      }
      return false;
    }
    if (!(d instanceof PadDevice) || !d.pad) {
      this.cancelCapture();
      return true;
    }
    if (this.capture.kind === 'rotation') {
      const ax = d.profile.layout.sticks;
      const q = rotationFromUp(d.pad.axes[ax[0]] ?? 0, d.pad.axes[ax[1]] ?? 0);
      if (q !== null) {
        this.setRotation(d.info.id, q);
        this.finishCapture(`${q * 90}°`);
      }
      return true;
    }
    if (this.looseKeys.includes('Escape')) {
      this.cancelCapture();
      return true;
    }
    const ref = detectPress(d.pad, { axes: this.captureRest }, d.profile.layout.hatAxis);
    if (!this.captureArmed) {
      // The press that started the capture (Confirm on the remap row) is still down: wait until everything is released.
      if (!ref) this.captureArmed = true;
      return true;
    }
    if (ref && this.capture.action) {
      const ov = this.overridesFor(d);
      ov.bindings = { ...(ov.bindings ?? {}), [this.capture.action]: [ref] };
      this.save();
      this.finishCapture(describeRef(ref));
    }
    return true;
  }

  clearBinding(deviceId: string, action: Action): void {
    const d = this.deviceById(deviceId);
    if (d instanceof KeyboardDevice) {
      const { [action]: _drop, ...rest } = d.keys.overrides;
      void _drop;
      d.keys.overrides = rest;
      this.persisted.keyboards[d.keys.layout.id] = { keys: rest };
      this.save();
    } else if (d instanceof PadDevice) {
      const ov = this.overridesFor(d);
      if (ov.bindings) {
        const { [action]: _drop, ...rest } = ov.bindings;
        void _drop;
        ov.bindings = rest;
        this.save();
      }
    }
  }

  resetBindings(deviceId: string): void {
    const d = this.deviceById(deviceId);
    if (d instanceof KeyboardDevice) {
      d.keys.overrides = {};
      delete this.persisted.keyboards[d.keys.layout.id];
      this.save();
    } else if (d instanceof PadDevice) {
      const ov = this.overridesFor(d);
      delete ov.bindings;
      this.save();
    }
  }

  beginCalibration(deviceId: string): void {
    const d = this.deviceById(deviceId);
    if (!(d instanceof PadDevice)) return;
    this.cancelCapture();
    this.calLeft = new StickCapture();
    this.calRight = new StickCapture();
    this.calibration = {
      phase: 'centre',
      device: deviceId,
      progress: 0,
      leftExtent: null,
      rightExtent: null,
    };
    // Measure the RAW stick: the old calibration must not colour the new one.
    d.calL = null;
    d.calR = null;
  }

  cancelCalibration(): void {
    this.calLeft = this.calRight = null;
    if (this.calibration.phase !== 'idle')
      this.calibration = { phase: 'idle', device: null, progress: 0, leftExtent: null, rightExtent: null };
  }

  private stepCalibration(): void {
    const c = this.calibration;
    if (c.phase !== 'centre' && c.phase !== 'range') return;
    const d = this.deviceById(c.device);
    if (!(d instanceof PadDevice) || !this.calLeft || !this.calRight) {
      this.cancelCalibration();
      return;
    }
    const s = d.state;
    const pl = this.calLeft.feed(s.lx, s.ly);
    this.calRight.feed(s.rx, s.ry);
    c.progress = pl;
    if (this.calLeft.phase === 'centre') c.phase = 'centre';
    else {
      c.phase = 'range';
      c.leftExtent = this.calLeft.result();
      c.rightExtent = this.calRight.phase === 'centre' ? null : this.calRight.result();
    }
    if (this.calLeft.phase === 'done') this.commitCalibration(d);
  }

  finishCalibration(): void {
    const c = this.calibration;
    const d = this.deviceById(c.device);
    if (!(d instanceof PadDevice) || !this.calLeft) return;
    if (this.calLeft.phase === 'centre') {
      this.cancelCalibration();
      return;
    }
    this.calLeft.finish();
    this.commitCalibration(d);
  }

  private commitCalibration(d: PadDevice): void {
    if (!this.calLeft || !this.calRight) return;
    const ov = this.overridesFor(d);
    d.calL = ov.calL = this.calLeft.result();
    // The right stick is stored only if the player actually rolled it around; the game does not use it.
    const r = this.calRight;
    if (r.phase === 'done') d.calR = ov.calR = r.result();
    else if (r.phase === 'range') {
      const res = r.result();
      if (res.minX > 0.7 && res.maxX > 0.7 && res.minY > 0.7 && res.maxY > 0.7) d.calR = ov.calR = res;
    }
    this.save();
    this.calibration = {
      phase: 'done',
      device: d.info.id,
      progress: 1,
      leftExtent: d.calL,
      rightExtent: d.calR,
    };
    this.calLeft = this.calRight = null;
  }

  clearCalibration(deviceId: string): void {
    const d = this.deviceById(deviceId);
    if (!(d instanceof PadDevice)) return;
    const ov = this.overridesFor(d);
    delete ov.calL;
    delete ov.calR;
    d.calL = d.calR = null;
    this.save();
  }

  setRotation(deviceId: string, quarterTurns: number | null): void {
    const d = this.deviceById(deviceId);
    if (!(d instanceof PadDevice)) return;
    const ov = this.overridesFor(d);
    if (quarterTurns === null) {
      delete ov.rotation;
      d.rotation = new PadDevice(d.info, d.profile, {}, this.getCfg).rotation;
    } else {
      const q = ((Math.round(quarterTurns) % 4) + 4) % 4;
      ov.rotation = q;
      d.rotation = q;
    }
    this.save();
  }

  /* ---------------------------------------------------------------------------------------------- *
   *  WebHID
   * ---------------------------------------------------------------------------------------------- */
  get hidStatus(): HidStatus {
    return this.hidState;
  }

  async requestHid(): Promise<void> {
    if (!this.hidApi) {
      this.hidState = 'unsupported';
      return;
    }
    if (this.hidState === 'requesting' || this.hidState === 'connected') return;
    this.hidState = 'requesting';
    try {
      const devs = await this.hidApi.requestDevice({ filters: [{ vendorId: NINTENDO_VENDOR }] });
      const d = devs.find((x) => x.productId === PRO_PRODUCT) ?? devs[0];
      if (!d) {
        this.hidState = 'denied';
        return;
      }
      await this.startHid(d);
    } catch (e) {
      const name = (e as { name?: string } | null)?.name;
      this.hidState = name === 'NotAllowedError' || name === 'SecurityError' ? 'denied' : 'error';
    }
  }

  private async autoConnectHid(): Promise<void> {
    try {
      const devs = (await this.hidApi?.getDevices()) ?? [];
      const d = devs.find((x) => x.vendorId === NINTENDO_VENDOR && x.productId === PRO_PRODUCT);
      if (d) await this.startHid(d);
    } catch {
      /* silent: the ordinary Gamepad path keeps working */
    }
  }

  private async startHid(d: HidDeviceLike): Promise<void> {
    const hp = new HidPad(d);
    await hp.start();
    this.hidPad = hp;
    this.hidSeenAt = this.clock();
    const profile = detectProfile(hp.pad.id, 'standard', this.ua);
    const info: DeviceInfo = {
      id: 'hid:0',
      kind: 'hid',
      name: `${profile.name} (HID)`,
      profile: profile.kind,
      family: 'nintendo',
      vendor: NINTENDO_VENDOR,
      product: d.productId,
      mapping: 'webhid',
      layoutId: profile.layout.id,
      rawId: hp.pad.id,
      index: 100,
      connected: true,
      slot: null,
      hasRumble: true,
      profileKey: profile.key,
    };
    this.hidDevice = new PadDevice(info, profile, this.persisted.devices[profile.key] ?? {}, this.getCfg);
    this.hidState = 'connected';
    this.persisted.hid = true;
    this.save();
    this.deviceSetChanged();
  }

  private async dropHid(status: HidStatus): Promise<void> {
    const hp = this.hidPad;
    this.hidPad = null;
    this.hidDevice = null;
    this.hidState = status;
    this.persisted.hid = false;
    this.save();
    if (hp) await hp.stop();
    for (const s of [0, 1] as const) if (this.manual[s] === 'hid:0') this.manual[s] = null;
    this.recomputeAssignment(true);
  }
}
