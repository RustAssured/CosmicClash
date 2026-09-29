import { LOGICAL_W, Btn } from '@/contracts';
import { ACTIONS, ALL_LAYOUTS, Pad, type Action, type DeviceInfo, type LiveDevice } from '@/input';
import { ACTION_TEXT } from '../labels';
import { PRO_H, disc, drawPro, ringLine } from '../pixel/controller-art';
import { C, accentRamp, alpha, mixRgb } from '../pixel/palette';
import { chip, drawIcon, meterBar, panel } from '../pixel/shapes';
import { drawText, measureText, wrapText } from '../pixel/text';
import {
  Menu,
  footer,
  header,
  promptLabels,
  scrim,
  vignette,
  type MenuItem,
  type Screen,
  type UICtx,
  backdrop,
} from './kit';

type Tab = 'live' | 'remap' | 'tools';
const TABS: { id: Tab; en: string; ko: string }[] = [
  { id: 'live', en: 'LIVE', ko: '실시간' },
  { id: 'remap', en: 'REMAP', ko: '재설정' },
  { id: 'tools', en: 'TOOLS', ko: '도구' },
];

const PX = 316;
const PY = 56;
const PW = LOGICAL_W - PX - 12;
const PH = 268;

const ROT_TEXT = ['0°', '90°', '180°', '270°'];

/**
 * Controller Check: a drawn pad lighting every input live, analog trigger fill, both sticks with their deadzone ring,
 * raw button/axis indices, the detected profile and layout, remap mode, calibration and orientation wizards, a rumble
 * test, and the optional WebHID enhancement. Everything the player could need to diagnose or fix a pad.
 */
export function createControllerScreen(): Screen {
  let tab: Tab = 'live';
  let row = -1;
  let devId: string | null = null;
  let manual = false;
  let toast: { text: string; until: number; bad?: boolean } | null = null;
  let remapMenu = new Menu([]);
  let toolsMenu = new Menu([]);

  const say = (ctx: UICtx, text: string, bad = false): void => {
    toast = { text, until: ctx.t + 2.6, bad };
  };

  const devices = (ctx: UICtx): readonly DeviceInfo[] => ctx.input.devices();

  /**
   * Which device is being inspected. Until the player cycles devices by hand, the screen follows whichever device they last
   * touched (so pressing buttons on a pad shows that pad); while a remap or wizard is running it stays put.
   */
  const ensureDevice = (ctx: UICtx): DeviceInfo | null => {
    const list = devices(ctx);
    const busy =
      ctx.input.capture.status === 'waiting' ||
      ctx.input.calibration.phase === 'centre' ||
      ctx.input.calibration.phase === 'range';
    const current = list.find((x) => x.id === devId) ?? null;
    if (current && (manual || busy)) return current;
    const active = ctx.input.lastActiveDevice();
    const d =
      list.find((x) => x.id === active?.id) ??
      current ??
      list.find((x) => x.kind !== 'keyboard') ??
      list[0] ??
      null;
    devId = d?.id ?? null;
    return d;
  };

  const buildRemap = (ctx: UICtx, dev: DeviceInfo | null): void => {
    const idx = remapMenu.index;
    const items: MenuItem[] = ACTIONS.map((a) => ({ id: a, en: ACTION_TEXT[a].en, ko: ACTION_TEXT[a].ko }));
    items.push({ id: 'reset', en: 'RESET TO DEFAULTS', ko: '기본값' });
    remapMenu = new Menu(items);
    remapMenu.set(idx);
    void ctx;
    void dev;
  };

  const buildTools = (ctx: UICtx, dev: DeviceInfo | null): void => {
    const idx = toolsMenu.index;
    const items: MenuItem[] = [];
    if (dev && dev.kind !== 'keyboard') {
      items.push(
        { id: 'calibrate', en: 'CALIBRATE STICKS', ko: '스틱 보정' },
        { id: 'orient', en: 'ORIENTATION WIZARD', ko: '방향 마법사' },
        { id: 'rotation', en: 'STICK ROTATION', ko: '스틱 회전' },
        { id: 'deadzone', en: 'DEADZONE', ko: '데드존' },
        { id: 'rumble', en: 'RUMBLE TEST', ko: '진동 시험' },
        { id: 'hid', en: 'ENHANCED MODE (WEBHID)', ko: '고급 모드' },
        { id: 'clearcal', en: 'CLEAR CALIBRATION', ko: '보정 삭제' },
      );
    } else {
      items.push({ id: 'none', en: 'KEYBOARDS NEED NO CALIBRATION', enabled: false });
    }
    toolsMenu = new Menu(items);
    toolsMenu.set(idx);
    void ctx;
  };

  return {
    enter(ctx, params) {
      const p = params as { tab?: Tab } | undefined;
      tab = p?.tab ?? 'live';
      row = tab === 'live' ? -1 : 0;
      devId = null;
      manual = false;
      toast = null;
      remapMenu = new Menu([]);
      toolsMenu = new Menu([]);
      const dev = ensureDevice(ctx);
      buildRemap(ctx, dev);
      buildTools(ctx, dev);
      ctx.input.ackCapture();
    },

    update(ctx) {
      const inp = ctx.input;
      const n = ctx.nav;
      const dev = ensureDevice(ctx);
      buildRemap(ctx, dev);
      buildTools(ctx, dev);

      // ---- capture / wizard states own the input ----
      const cap = inp.capture;
      if (cap.status === 'waiting') return;
      if (cap.status === 'done') {
        say(
          ctx,
          cap.kind === 'rotation'
            ? `ROTATION SET TO ${cap.result}`
            : `${ACTION_TEXT[cap.action!].en} → ${cap.result}`,
        );
        ctx.sound('confirm');
        inp.ackCapture();
        return;
      }
      if (cap.status === 'cancelled') {
        say(ctx, 'CANCELLED', true);
        inp.ackCapture();
        return;
      }
      const cal = inp.calibration;
      if (cal.phase === 'centre' || cal.phase === 'range') {
        if (n.back) {
          inp.cancelCalibration();
          say(ctx, 'CALIBRATION CANCELLED', true);
          ctx.sound('back');
        } else if (n.confirm && cal.phase === 'range') {
          inp.finishCalibration();
        }
        return;
      }
      if (cal.phase === 'done') {
        say(ctx, 'CALIBRATION SAVED');
        ctx.sound('confirm');
        inp.cancelCalibration();
        return;
      }

      // ---- normal navigation ----
      if (n.tab) {
        const list = devices(ctx);
        if (list.length > 1) {
          const i = list.findIndex((d) => d.id === devId);
          devId = list[(i + 1) % list.length]!.id;
          manual = true;
          ctx.sound('move');
        }
      }
      if (n.back || n.start) {
        ctx.sound('back');
        ctx.pop();
        return;
      }
      if (row === -1) {
        if (n.left || n.right) {
          const i = TABS.findIndex((t) => t.id === tab);
          tab = TABS[(i + (n.right ? 1 : -1) + TABS.length) % TABS.length]!.id;
          ctx.sound('move');
        }
        if (n.down && tab !== 'live') {
          row = 0;
          ctx.sound('move');
        }
        return;
      }
      const menu = tab === 'remap' ? remapMenu : toolsMenu;
      if (n.up && menu.index === 0) {
        row = -1;
        ctx.sound('move');
        return;
      }
      if (menu.step(n)) ctx.sound('move');
      const id = menu.current.id;
      if (!dev) return;

      if (tab === 'remap') {
        if (n.confirm) {
          if (id === 'reset') {
            inp.resetBindings(dev.id);
            say(ctx, 'BINDINGS RESET');
            ctx.sound('confirm');
          } else {
            inp.beginCapture(dev.id, id as Action);
            ctx.sound('confirm');
          }
        }
        return;
      }
      // tools
      const live = inp.live(dev.id);
      if (id === 'deadzone' && (n.left || n.right)) {
        inp.updateSettings({
          deadzone:
            Math.round(
              Math.max(0.05, Math.min(0.45, inp.settings.deadzone + (n.right ? 0.01 : -0.01))) * 100,
            ) / 100,
        });
        ctx.sound('tick');
      } else if (id === 'rotation' && (n.left || n.right || n.confirm)) {
        const cur = live?.rotation ?? 0;
        inp.setRotation(dev.id, (cur + (n.left ? 3 : 1)) % 4);
        ctx.sound('tick');
      } else if (n.confirm) {
        switch (id) {
          case 'calibrate':
            inp.beginCalibration(dev.id);
            ctx.sound('confirm');
            break;
          case 'orient':
            inp.beginRotationWizard(dev.id);
            ctx.sound('confirm');
            break;
          case 'rumble':
            inp.rumbleDevice(dev.id, 1, 0.6, 320);
            say(ctx, dev.hasRumble ? 'RUMBLE SENT' : 'THIS DEVICE REPORTS NO RUMBLE', !dev.hasRumble);
            ctx.sound('confirm');
            break;
          case 'hid':
            if (inp.hidStatus === 'unsupported') {
              say(ctx, 'WEBHID IS CHROME/EDGE ONLY', true);
              ctx.sound('error');
            } else {
              void inp.requestHid();
              ctx.sound('confirm');
            }
            break;
          case 'clearcal':
            inp.clearCalibration(dev.id);
            say(ctx, 'CALIBRATION CLEARED');
            ctx.sound('confirm');
            break;
        }
      }
    },

    draw(ctx) {
      const cv = ctx.cv;
      backdrop(cv, 'bg:0.78:0.68:0.82:', (bg) => {
        scrim(bg, 0.78, 0.68, 0.82);
        vignette(bg);
      });
      header(ctx, 'CONTROLLER CHECK', '조작 확인');
      const dev = ensureDevice(ctx);
      drawDeviceTabs(ctx, dev);
      if (!dev) {
        drawText(cv, 'NO DEVICE - PRESS ANY BUTTON', LOGICAL_W / 2, 160, {
          color: C.gold,
          align: 'center',
          tracking: 2,
        });
        footer(ctx, [{ chip: promptLabels(ctx).back, text: 'BACK' }]);
        return;
      }
      const live = ctx.input.live(dev.id)!;
      const ramp = accentRamp(dev.slot === 1 ? '#6cc6dc' : dev.slot === 0 ? '#f2b866' : '#a8bdb2');
      drawPadPane(ctx, dev, live, ramp.base);
      drawRightPane(ctx, dev, live);
      drawOverlays(ctx, dev, live);
      if (toast && ctx.t < toast.until) {
        const w = measureText(toast.text, { tracking: 1 }) + 20;
        const x = PX + PW / 2 - w / 2;
        cv.rect(x, PY + PH - 26, w, 18, alpha(C.ink0, 0.96));
        cv.frame(x, PY + PH - 26, w, 18, toast.bad ? C.danger : C.celadonDeep);
        drawText(cv, toast.text, PX + PW / 2, PY + PH - 23, {
          color: toast.bad ? C.danger : C.celadonLight,
          align: 'center',
          tracking: 1,
        });
      }
      const p = promptLabels(ctx);
      const items = [
        { chip: p.confirm, text: tab === 'remap' ? 'REBIND' : 'SELECT' },
        { chip: p.back, text: 'BACK' },
        { chip: p.tab, text: 'NEXT DEVICE', dim: devices(ctx).length < 2 },
      ];
      footer(ctx, items);
    },
  };

  /* ---------------------------------------------------------------------------------------------- */
  function drawDeviceTabs(ctx: UICtx, dev: DeviceInfo | null): void {
    const cv = ctx.cv;
    let x = 24;
    for (const d of devices(ctx)) {
      const sel = dev?.id === d.id;
      const slot = d.slot === null ? '' : `P${d.slot + 1}  `;
      const label = `${slot}${d.name.toUpperCase()}`;
      const w = measureText(label, { tracking: 0 }) + 16;
      if (x + w > LOGICAL_W - 24) break;
      const col = d.slot === 0 ? C.p1 : d.slot === 1 ? C.p2 : C.mid;
      cv.rect(x, 39, w, 14, alpha(sel ? C.ink3 : C.ink1, 0.95));
      cv.frame(x, 39, w, 14, sel ? col : C.line0);
      if (sel) cv.hline(x + 1, 52, w - 2, col);
      drawText(cv, label, x + 8, 39, { color: sel ? C.white : C.dim, valign: 'cap' });
      x += w + 6;
    }
  }

  function drawPadPane(ctx: UICtx, dev: DeviceInfo, live: LiveDevice, accent: number): void {
    const cv = ctx.cv;
    const fam = ctx.input.familyOf(dev.id);
    if (dev.kind === 'keyboard') {
      drawKeyboardPane(ctx, dev, live, accent);
      return;
    }
    const b = live.canon;
    drawPro(
      cv,
      20,
      60,
      { b, lx: live.left[0], ly: live.left[1], rx: live.right[0], ry: live.right[1] },
      accent,
      ctx.input.settings.labelMode === 'auto' ? fam : ctx.input.promptFamily(),
    );
    // stick gates
    const gy = 60 + PRO_H + 40;
    gate(ctx, 60, gy, 30, live.rawLeft, live.left, live.deadzone, 'LEFT STICK', accent);
    gate(ctx, 160, gy, 30, live.rawRight, live.right, live.deadzone, 'RIGHT STICK', accent);
    // trigger bars
    for (const [i, lab, key] of [
      [0, 'ZL', Pad.L2],
      [1, 'ZR', Pad.R2],
    ] as const) {
      const x = 224 + i * 34;
      const v = b[key] ?? 0;
      cv.rect(x, gy - 30, 12, 60, C.ink2);
      cv.frame(x - 1, gy - 31, 14, 62, C.line0);
      const fh = Math.round(60 * v);
      if (fh > 0) cv.rect(x, gy + 30 - fh, 12, fh, accent);
      drawText(cv, lab, x + 6, gy + 36, { color: C.dim, font: 'micro', align: 'center' });
      drawText(cv, v.toFixed(2), x + 6, gy - 42, {
        color: v > 0.5 ? C.white : C.dim,
        font: 'micro',
        align: 'center',
      });
    }
  }

  function gate(
    ctx: UICtx,
    cx: number,
    cy: number,
    r: number,
    raw: [number, number],
    proc: [number, number],
    dz: number,
    label: string,
    accent: number,
  ): void {
    const cv = ctx.cv;
    disc(cv, cx, cy, r, alpha(C.ink1, 0.95));
    ringLine(cv, cx, cy, r, C.line1);
    cv.hline(cx - r, cy, r * 2 + 1, C.line0);
    cv.vline(cx, cy - r, r * 2 + 1, C.line0);
    ringLine(cv, cx, cy, Math.max(1, Math.round(r * dz)), C.dim, true);
    // raw (hollow) and processed (solid)
    const rx = cx + Math.round(raw[0] * r);
    const ry = cy + Math.round(raw[1] * r);
    cv.frame(rx - 2, ry - 2, 5, 5, C.mid);
    const px = cx + Math.round(proc[0] * r);
    const py = cy + Math.round(proc[1] * r);
    cv.rect(px - 1, py - 1, 3, 3, accent);
    cv.px(px, py, C.white);
    drawText(cv, label, cx, cy - r - 12, { color: C.dim, font: 'micro', align: 'center', tracking: 1 });
    drawText(
      cv,
      `${raw[0] >= 0 ? '+' : ''}${raw[0].toFixed(2)} ${raw[1] >= 0 ? '+' : ''}${raw[1].toFixed(2)}`,
      cx,
      cy + r + 6,
      { color: C.mid, font: 'micro', align: 'center' },
    );
  }

  function drawKeyboardPane(ctx: UICtx, dev: DeviceInfo, live: LiveDevice, accent: number): void {
    const cv = ctx.cv;
    panel(cv, 20, 64, 280, 250, { accent: C.line2 });
    drawText(cv, dev.name.toUpperCase(), 34, 74, { color: C.white, tracking: 1 });
    ACTIONS.forEach((a, i) => {
      const y = 100 + i * 22;
      const on = (live.actions & actionBit(a)) !== 0;
      cv.rect(34, y - 3, 252, 18, on ? alpha(accent, 0.28) : alpha(C.ink2, 0.6));
      cv.frame(34, y - 3, 252, 18, on ? accent : C.line0);
      drawText(cv, ACTION_TEXT[a].en, 42, y, { color: on ? C.white : C.mid, tracking: 1 });
      chip(
        cv,
        286 - 4 - measureText(ctx.input.actionLabel(dev.id, a), { font: 'micro' }) - 10,
        y,
        ctx.input.actionLabel(dev.id, a),
        { color: on ? accent : C.line2, text: on ? C.white : C.soft },
      );
    });
    drawText(
      cv,
      `MOVE  ${live.left[0] >= 0 ? '+' : ''}${live.left[0].toFixed(2)} ${live.left[1] >= 0 ? '+' : ''}${live.left[1].toFixed(2)}`,
      34,
      300,
      { color: C.dim, font: 'micro', tracking: 1 },
    );
  }

  function drawRightPane(ctx: UICtx, dev: DeviceInfo, live: LiveDevice): void {
    const cv = ctx.cv;
    panel(cv, PX, PY, PW, PH, { accent: C.celadonDeep });
    // tab bar
    let tx = PX + 14;
    for (const t of TABS) {
      const sel = t.id === tab;
      const w = measureText(t.en, { tracking: 2 }) + 18;
      const focused = sel && row === -1;
      if (sel) {
        cv.rect(tx, PY + 8, w, 15, alpha(C.ink3, 1));
        cv.frame(tx, PY + 8, w, 15, focused ? C.celadon : C.line1);
        cv.hline(tx + 1, PY + 22, w - 2, C.celadon);
      }
      drawText(cv, t.en, tx + 9, PY + 9, { color: sel ? C.white : C.dim, tracking: 2, valign: 'cap' });
      if (sel) drawText(cv, t.ko, tx + w + 4, PY + 10, { color: C.celadonDeep });
      tx += w + 4 + (sel ? measureText(t.ko) + 10 : 0) + 8;
    }
    cv.hline(PX + 8, PY + 26, PW - 16, C.line0);
    if (tab === 'live') drawLive(ctx, dev, live);
    else if (tab === 'remap') drawRemap(ctx, dev, live);
    else drawTools(ctx, dev, live);
  }

  function drawLive(ctx: UICtx, dev: DeviceInfo, live: LiveDevice): void {
    const cv = ctx.cv;
    const x = PX + 14;
    let y = PY + 36;
    drawText(cv, dev.name.toUpperCase(), x, y, { color: C.white, tracking: 1 });
    const fam = dev.family === 'keyboard' ? 'KEYBOARD' : dev.family.toUpperCase();
    drawText(cv, fam, PX + PW - 14, y + 1, {
      color: C.celadonDeep,
      font: 'micro',
      tracking: 1,
      align: 'right',
    });
    y += 16;
    const idLines = wrapText(dev.rawId || '-', PW - 28, { font: 'micro' }).slice(0, 2);
    for (const l of idLines) {
      drawText(cv, l, x, y, { color: C.dim, font: 'micro' });
      y += 7;
    }
    y += 3;
    const vp =
      dev.vendor === null
        ? 'UNKNOWN'
        : `${dev.vendor.toString(16).padStart(4, '0').toUpperCase()}:${(dev.product ?? 0).toString(16).padStart(4, '0').toUpperCase()}`;
    drawText(cv, `VENDOR:PRODUCT ${vp}`, x, y, { color: C.mid, font: 'micro', tracking: 1 });
    drawText(cv, `MAPPING ${dev.mapping.toUpperCase()}`, PX + PW - 14, y, {
      color: dev.mapping === 'standard' ? C.ok : C.gold,
      font: 'micro',
      tracking: 1,
      align: 'right',
    });
    y += 9;
    const lay = ALL_LAYOUTS.find((l) => l.id === dev.layoutId);
    drawText(cv, `LAYOUT ${dev.layoutId.toUpperCase()}`, x, y, { color: C.mid, font: 'micro', tracking: 1 });
    drawText(cv, dev.hasRumble ? 'RUMBLE OK' : 'NO RUMBLE', PX + PW - 14, y, {
      color: dev.hasRumble ? C.mid : C.line2,
      font: 'micro',
      tracking: 1,
      align: 'right',
    });
    y += 9;
    if (dev.kind === 'gamepad' && dev.mapping !== 'standard' && lay) {
      for (const l of wrapText('TABLE NOT HARDWARE-VERIFIED: IF A BUTTON READS WRONG USE REMAP', PW - 28, {
        font: 'micro',
      })) {
        drawText(cv, l, x, y, { color: C.gold, font: 'micro' });
        y += 7;
      }
    }
    y += 4;
    cv.hline(x, y, PW - 28, C.line0);
    y += 7;
    // raw buttons
    drawText(cv, 'RAW BUTTONS', x, y, { color: C.dim, font: 'micro', tracking: 1 });
    y += 9;
    const nb = Math.max(live.rawButtons.length, 0);
    const bw = 16;
    for (let i = 0; i < nb; i++) {
      const bx = x + (i % 17) * (bw + 1);
      const by = y + Math.floor(i / 17) * 13;
      const v = live.rawButtons[i] ?? 0;
      cv.rect(bx, by, bw, 11, C.ink2);
      if (v > 0.02)
        cv.rect(
          bx,
          by + 11 - Math.max(1, Math.round(11 * v)),
          bw,
          Math.max(1, Math.round(11 * v)),
          v > 0.5 ? C.celadon : C.celadonDeep,
        );
      cv.frame(bx, by, bw, 11, v > 0.5 ? C.celadonLight : C.line0);
      drawText(cv, String(i), bx + bw / 2, by + 3, {
        color: v > 0.5 ? C.void : C.dim,
        font: 'micro',
        align: 'center',
      });
    }
    if (nb === 0)
      drawText(cv, dev.kind === 'keyboard' ? 'KEYBOARD: SEE ACTION LIST' : 'NO BUTTONS REPORTED', x, y, {
        color: C.line2,
        font: 'micro',
      });
    y += Math.ceil(Math.max(1, nb) / 17) * 13 + 5;
    // raw axes
    drawText(cv, 'RAW AXES', x, y, { color: C.dim, font: 'micro', tracking: 1 });
    y += 9;
    const na = live.rawAxes.length;
    for (let i = 0; i < Math.min(na, 12); i++) {
      const col = i % 2;
      const r = Math.floor(i / 2);
      const ax = x + col * 140;
      const ay = y + r * 12;
      const v = live.rawAxes[i] ?? 0;
      drawText(cv, `A${i}`, ax, ay, { color: C.dim, font: 'micro' });
      cv.rect(ax + 14, ay, 78, 5, C.ink2);
      cv.frame(ax + 13, ay - 1, 80, 7, C.line0);
      const c = ax + 14 + 39;
      const half = Math.round(Math.max(-1.3, Math.min(1.3, v)) * 38);
      const isHat = dev.mapping !== 'standard' && Math.abs(v) > 1 && i === 9;
      cv.rect(
        Math.min(c, c + half),
        ay,
        Math.max(1, Math.abs(half)),
        5,
        isHat ? C.gold : Math.abs(v) > 0.5 ? C.celadon : C.celadonDeep,
      );
      cv.vline(c, ay - 1, 7, C.line2);
      drawText(cv, `${v >= 0 ? '+' : ''}${v.toFixed(2)}`, ax + 96, ay, {
        color: Math.abs(v) > 0.1 ? C.soft : C.line2,
        font: 'micro',
      });
    }
    // what the GAME sees after the layout table, deadzone and any remaps
    const ay0 = PY + PH - 66;
    cv.hline(x, ay0 - 6, PW - 28, C.line0);
    drawText(cv, 'GAME ACTIONS', x, ay0, { color: C.dim, font: 'micro', tracking: 1 });
    if (live.hat)
      drawText(cv, `HAT ${live.hat.toUpperCase()}`, PX + PW - 14, ay0, {
        color: C.gold,
        font: 'micro',
        tracking: 1,
        align: 'right',
      });
    ACTIONS.forEach((a, i) => {
      const cx = x + (i % 3) * 96;
      const cy = ay0 + 10 + Math.floor(i / 3) * 15;
      const on = (live.actions & actionBit(a)) !== 0;
      cv.rect(cx, cy, 92, 12, on ? alpha(C.celadon, 0.85) : alpha(C.ink2, 0.8));
      cv.frame(cx, cy, 92, 12, on ? C.celadonLight : C.line0);
      drawText(cv, ACTION_TEXT[a].en, cx + 5, cy + 4, {
        color: on ? C.void : C.mid,
        font: 'micro',
        tracking: 1,
      });
      const lab = ctx.input.actionLabel(dev.id, a);
      drawText(cv, lab, cx + 88, cy + 4, { color: on ? C.void : C.dim, font: 'micro', align: 'right' });
    });
  }

  function drawRemap(ctx: UICtx, dev: DeviceInfo, live: LiveDevice): void {
    const cv = ctx.cv;
    const x = PX + 14;
    const y0 = PY + 34;
    drawText(
      cv,
      dev.kind === 'keyboard'
        ? 'PRESS A KEY TO REBIND. ESC CANCELS.'
        : 'PICK AN ACTION, THEN PRESS THE INPUT YOU WANT.',
      x,
      y0 - 2,
      { color: C.dim, font: 'micro', tracking: 1 },
    );
    remapMenu.items.forEach((it, i) => {
      const y = y0 + 12 + i * 22;
      const focus = row >= 0 && tab === 'remap' && i === remapMenu.index;
      if (focus) {
        cv.rect(x - 4, y - 4, PW - 20, 19, alpha(C.ink3, 1));
        cv.frame(x - 4, y - 4, PW - 20, 19, C.celadonDeep);
        drawIcon(cv, 'chevron', x, y + 2, C.celadon);
      }
      drawText(cv, it.en, x + 10, y, { color: focus ? C.white : C.soft, tracking: 1 });
      if (it.ko)
        drawText(cv, it.ko, x + 10 + measureText(it.en, { tracking: 1 }) + 8, y, {
          color: focus ? C.celadonDeep : C.line2,
        });
      if (it.id !== 'reset') {
        const label = ctx.input.actionLabel(dev.id, it.id as Action);
        const custom = live.custom.includes(it.id as Action);
        const cw = measureText(label, { font: 'micro' }) + (Array.from(label).length === 1 ? 9 : 6);
        chip(cv, PX + PW - 14 - Math.max(cw, 9) - 46, y - 1, label, {
          color: custom ? C.gold : C.mid,
          text: C.white,
        });
        drawText(cv, custom ? 'CUSTOM' : 'DEFAULT', PX + PW - 16, y + 1, {
          color: custom ? C.gold : C.line2,
          font: 'micro',
          align: 'right',
          tracking: 1,
        });
      }
    });
  }

  function drawTools(ctx: UICtx, dev: DeviceInfo, live: LiveDevice): void {
    const cv = ctx.cv;
    const x = PX + 14;
    const y0 = PY + 38;
    toolsMenu.items.forEach((it, i) => {
      const y = y0 + i * 26;
      const focus = row >= 0 && tab === 'tools' && i === toolsMenu.index;
      if (focus) {
        cv.rect(x - 4, y - 5, PW - 20, 22, alpha(C.ink3, 1));
        cv.frame(x - 4, y - 5, PW - 20, 22, C.celadonDeep);
        drawIcon(cv, 'chevron', x, y + 2, C.celadon);
      }
      drawText(cv, it.en, x + 10, y, {
        color: it.enabled === false ? C.line2 : focus ? C.white : C.soft,
        tracking: 1,
      });
      if (it.ko && focus && it.enabled !== false)
        drawText(cv, it.ko, x + 10 + measureText(it.en, { tracking: 1 }) + 8, y, { color: C.celadonDeep });
      let val = '';
      let col: number = C.mid;
      switch (it.id) {
        case 'calibrate':
        case 'clearcal':
          val = live.hasCalibration ? 'STORED' : 'NONE';
          col = live.hasCalibration ? C.ok : C.dim;
          break;
        case 'orient':
          val = `ROT ${ROT_TEXT[live.rotation]}`;
          break;
        case 'rotation':
          val = ROT_TEXT[live.rotation]!;
          break;
        case 'deadzone':
          val = `${Math.round(live.deadzone * 100)}%`;
          break;
        case 'rumble':
          val = dev.hasRumble ? 'READY' : 'N/A';
          col = dev.hasRumble ? C.ok : C.dim;
          break;
        case 'hid': {
          const s = ctx.input.hidStatus;
          val =
            s === 'unsupported'
              ? 'UNAVAILABLE'
              : s === 'connected'
                ? 'CONNECTED'
                : s === 'requesting'
                  ? 'ASKING...'
                  : s === 'denied'
                    ? 'DENIED'
                    : s === 'error'
                      ? 'FAILED'
                      : 'ENABLE';
          col =
            s === 'connected'
              ? C.ok
              : s === 'unsupported' || s === 'denied' || s === 'error'
                ? C.dim
                : C.gold;
          break;
        }
      }
      if (val)
        drawText(cv, val, PX + PW - 18, y + 1, { color: focus ? C.white : col, tracking: 1, align: 'right' });
      if (focus && (it.id === 'deadzone' || it.id === 'rotation')) {
        drawIcon(cv, 'arrowL', PX + PW - 18 - measureText(val, { tracking: 1 }) - 9, y + 3, C.celadon);
        drawIcon(cv, 'arrowR', PX + PW - 14, y + 3, C.celadon);
      }
    });
    if (dev.kind !== 'keyboard') {
      const hint =
        ctx.input.hidStatus === 'unsupported'
          ? 'WebHID needs Chrome or Edge; other browsers use the standard Gamepad API.'
          : 'WebHID reads the pad directly for lower latency. It needs a key or mouse press and degrades silently.';
      let y = PY + PH - 62;
      for (const l of wrapText(hint, PW - 28, { font: 'micro' })) {
        drawText(cv, l, x, y, { color: C.line2, font: 'micro' });
        y += 7;
      }
    }
  }

  function drawOverlays(ctx: UICtx, dev: DeviceInfo, live: LiveDevice): void {
    const cv = ctx.cv;
    const cap = ctx.input.capture;
    const cal = ctx.input.calibration;
    let title = '';
    let sub = '';
    let prog: number | null = null;
    if (cap.status === 'waiting') {
      if (cap.kind === 'rotation') {
        title = 'PUSH THE STICK AWAY FROM YOU';
        sub = 'HOLD IT FIRMLY UP AS YOU PLAY.';
      } else {
        title = `PRESS THE ${dev.kind === 'keyboard' ? 'KEY' : 'BUTTON'} FOR ${ACTION_TEXT[cap.action!].en}`;
        sub =
          dev.kind === 'keyboard'
            ? 'ESC CANCELS. TIMES OUT AFTER 12 SECONDS.'
            : 'KEYBOARD ESC CANCELS. TIMES OUT AFTER 12 SECONDS.';
      }
    } else if (cal.phase === 'centre') {
      title = 'LET GO OF THE STICKS';
      sub = 'MEASURING THE RESTING CENTRE...';
      prog = cal.progress;
    } else if (cal.phase === 'range') {
      title = 'ROLL THE LEFT STICK AROUND ITS EDGE';
      sub = 'SLOWLY, THEN LET GO.  CONFIRM = DONE, BACK = CANCEL.';
      prog = cal.progress;
    } else return;
    void live;
    cv.rect(0, 0, LOGICAL_W, 360, alpha(C.void, 0.72));
    const w = 400;
    const x = (LOGICAL_W - w) / 2;
    const y = 132;
    panel(cv, x, y, w, 88, { accent: C.gold, fill: alpha(C.ink1, 0.97) });
    drawText(cv, title, LOGICAL_W / 2, y + 16, { color: C.white, align: 'center', tracking: 1 });
    drawText(cv, sub, LOGICAL_W / 2, y + 36, { color: C.dim, align: 'center', font: 'micro', tracking: 1 });
    if (prog !== null) meterBar(cv, x + 30, y + 56, w - 60, 8, prog, accentRamp('#ecc98a'), { ticks: true });
    else {
      const n = Math.floor(ctx.t * 6) % 4;
      drawText(cv, '.'.repeat(n + 1), LOGICAL_W / 2, y + 56, { color: C.gold, align: 'center', tracking: 3 });
    }
    void mixRgb;
  }
}

function actionBit(a: Action): number {
  switch (a) {
    case 'strike':
      return Btn.STRIKE;
    case 'crush':
      return Btn.CRUSH;
    case 'surge':
      return Btn.SURGE;
    case 'signature':
      return Btn.SIGNATURE;
    case 'ultimate':
      return Btn.ULTIMATE;
    case 'guard':
      return Btn.GUARD;
    case 'feint':
      return Btn.FEINT;
    case 'pause':
      return Btn.PAUSE;
    case 'training':
      return Btn.TRAINING;
  }
}
