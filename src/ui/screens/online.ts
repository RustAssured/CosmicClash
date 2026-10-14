import { LOGICAL_W, type StageId, type TitanId } from '@/contracts';
import { ROOM_ALPHABET, ROOM_CODE_LENGTH, normaliseRoomCode } from '@/net/config';
import type { OnlineUiPort, OnlineView } from '@/net/types';
import type { PixelCanvas } from '../pixel/canvas';
import { C, accentRamp, alpha } from '../pixel/palette';
import { drawIcon, panel } from '../pixel/shapes';
import { drawText, measureText } from '../pixel/text';
import {
  Menu,
  backdrop,
  confirmBack,
  drawCentreMenu,
  drawTitanPortrait,
  footer,
  header,
  pillar,
  portraitSprite,
  promptLabels,
  scrim,
  settled,
  vignette,
  type Screen,
  type UICtx,
} from './kit';
import { gridOf, gridStep } from './select';

const ACCENT = accentRamp('#6cc6dc');
const SLOT_COL = [C.p1, C.p2] as const;

/* ------------------------------------------------------------------------------------------------ *
 *  typed room codes: the keyboard types (a window listener), a pad dials letters with the stick
 * ------------------------------------------------------------------------------------------------ */
const typed: {
  buf: string;
  submit: boolean;
  cancel: boolean;
  at: number;
  listening: boolean;
  /** The session the screen drives: keys are taken only while its phase is 'code'. */
  port: OnlineUiPort | null;
  /** False until this visit to the code phase has cleared the buffer. */
  armed: boolean;
} = {
  buf: '',
  submit: false,
  cancel: false,
  at: 0,
  listening: false,
  port: null,
  armed: false,
};

/** Entering the code phase: an empty code, nothing pending (idempotent within one visit). */
function armCode(): void {
  if (typed.armed) return;
  typed.armed = true;
  typed.buf = '';
  typed.submit = typed.cancel = false;
}

function listenForCode(): void {
  if (typed.listening || typeof window === 'undefined') return;
  typed.listening = true;
  // the phase, not the frame clock: on a slow machine frames may be a second apart and no key may be lost between them
  const live = (): boolean => {
    const on = typed.port?.view.phase === 'code';
    if (on) armCode();
    return on;
  };
  window.addEventListener('keydown', (e) => {
    if (!live() || e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key;
    if (k === 'Enter') typed.submit = true;
    else if (k === 'Escape') typed.cancel = true;
    else if (k === 'Backspace') typed.buf = typed.buf.slice(0, -1);
    else if (k.length === 1 && ROOM_ALPHABET.includes(k.toUpperCase()) && typed.buf.length < ROOM_CODE_LENGTH)
      typed.buf += k.toUpperCase();
    else return;
    typed.at = performance.now();
  });
  window.addEventListener('paste', (e) => {
    if (!live()) return;
    const code = normaliseRoomCode(e.clipboardData?.getData('text') ?? '');
    if (code) {
      typed.buf = code;
      typed.at = performance.now();
    }
  });
}

function port(ctx: UICtx): OnlineUiPort | null {
  return ctx.deps.online ?? null;
}

/**
 * ONLINE / 온라인 (docs/netplay/STEP1.md §4): CREATE ROOM (code + link, waiting), JOIN ROOM (type a code; a `?room=` link
 * comes straight here), the online titan select (host = P1, guest = P2), the host's stage pick, the countdown, the
 * rematch wait, the LEAVE prompt over a running match, and the stop screens (error, opponent left, connection lost,
 * desync).
 */
export function createOnlineScreen(): Screen {
  const menu = new Menu([
    { id: 'create', en: 'CREATE ROOM', ko: '방 만들기' },
    { id: 'join', en: 'JOIN ROOM', ko: '방 참가' },
    { id: 'back', en: 'BACK', ko: '뒤로' },
  ]);
  const errMenu = new Menu([
    { id: 'ok', en: 'BACK TO TITLE', ko: '제목 화면' },
    { id: 'log', en: 'SAVE DESYNC LOG', ko: '기록 저장' },
  ]);
  const errOnly = new Menu([errMenu.items[0]!]);
  let cursor = 0;
  let stageIdx = 0;
  let lastPhase = '';

  const stagesOf = (p: OnlineUiPort): (StageId | 'random')[] => ['random', ...p.stages];

  return {
    enter(ctx) {
      listenForCode();
      const p = port(ctx);
      typed.port = p;
      menu.set(0);
      errMenu.set(0);
      if (p) {
        const v = p.view;
        cursor = Math.max(0, p.titans.indexOf(v.myPick));
        if (v.phase === 'error' || v.phase === 'menu') lastPhase = '';
      }
    },
    update(ctx) {
      const p = port(ctx);
      if (!p) {
        if (ctx.nav.back || ctx.nav.confirm) ctx.go('title');
        return;
      }
      const v = p.view;
      const n = ctx.nav;
      typed.port = p;
      if (v.phase !== 'code') typed.armed = false;
      else armCode();
      if (v.phase !== lastPhase) {
        // fresh entry into a phase
        if (v.phase === 'select') cursor = Math.max(0, p.titans.indexOf(v.myPick));
        if (v.phase === 'stage') stageIdx = Math.max(0, stagesOf(p).indexOf(v.stage));
        if (v.phase === 'error') errMenu.set(0);
        lastPhase = v.phase;
      }
      ctx.resetIdle();
      switch (v.phase) {
        case 'menu': {
          const off = v.transport === 'off';
          menu.items[0]!.enabled = !off;
          menu.items[1]!.enabled = !off;
          if (off && menu.index < 2) menu.set(2);
          if (menu.step(n)) ctx.sound('move');
          if (n.back) {
            ctx.sound('back');
            p.leave();
            return;
          }
          if (!n.confirm) return;
          ctx.sound('confirm');
          if (menu.current.id === 'create') p.host();
          else if (menu.current.id === 'join') p.openCode();
          else p.leave();
          return;
        }
        case 'code': {
          if (typed.submit || typed.cancel) {
            const sub = typed.submit;
            typed.submit = typed.cancel = false;
            if (sub && typed.buf.length === ROOM_CODE_LENGTH) {
              ctx.sound('confirm');
              p.join(typed.buf);
            } else if (!sub) {
              ctx.sound('back');
              p.openMenu();
            } else ctx.sound('error');
            return;
          }
          // a pad dials the code; keyboard nav keys are letters here, so the keyboard only types
          const dev = ctx.input.lastActiveDevice();
          if (dev && dev.kind === 'keyboard') return;
          // up / down turn the last letter through the alphabet; right (or confirm) adds the next letter
          const last = typed.buf.length - 1;
          const ch = last >= 0 ? typed.buf[last]! : null;
          if (n.up || n.down) {
            const k = ROOM_ALPHABET.length;
            const i = ch ? ROOM_ALPHABET.indexOf(ch) : -1;
            const next = ROOM_ALPHABET[(((i < 0 ? 0 : i + (n.up ? 1 : -1)) % k) + k) % k]!;
            typed.buf = ch ? typed.buf.slice(0, last) + next : next;
            ctx.sound('move');
          }
          if (n.right && typed.buf.length < ROOM_CODE_LENGTH) {
            typed.buf += ROOM_ALPHABET[0];
            ctx.sound('move');
          }
          if (n.left && typed.buf.length > 0) {
            typed.buf = typed.buf.slice(0, -1);
            ctx.sound('move');
          }
          if (n.confirm) {
            if (typed.buf.length === ROOM_CODE_LENGTH) {
              ctx.sound('confirm');
              p.join(typed.buf);
            } else {
              typed.buf += ROOM_ALPHABET[0];
              ctx.sound('move');
            }
          }
          if (n.back) {
            ctx.sound('back');
            if (typed.buf.length) typed.buf = typed.buf.slice(0, -1);
            else p.openMenu();
          }
          return;
        }
        case 'creating':
        case 'connecting':
          if (n.back) {
            ctx.sound('back');
            p.openMenu();
          }
          return;
        case 'waiting':
          if (n.confirm) {
            ctx.sound('confirm');
            p.copyLink();
          }
          if (n.back) {
            ctx.sound('back');
            p.openMenu();
          }
          return;
        case 'select': {
          const ts = p.titans;
          if (!v.myLocked) {
            let i = cursor;
            if (n.left) i = (i - 1 + ts.length) % ts.length;
            else if (n.right) i = (i + 1) % ts.length;
            else if (n.up) i = gridStep(ts.length, i, -1);
            else if (n.down) i = gridStep(ts.length, i, 1);
            if (i !== cursor) {
              cursor = i;
              ctx.sound('move');
              p.pick(ts[i]!);
            }
            if (n.confirm) {
              ctx.sound('select');
              p.pick(ts[cursor]!);
              p.lock(true);
            } else if (n.back) {
              ctx.sound('back');
              p.leave();
            }
          } else if (n.back) {
            ctx.sound('back');
            p.lock(false);
          }
          return;
        }
        case 'stage': {
          if (v.role === 'host') {
            const list = stagesOf(p);
            let i = stageIdx;
            if (n.up) i = (i - 1 + list.length) % list.length;
            else if (n.down) i = (i + 1) % list.length;
            if (i !== stageIdx) {
              stageIdx = i;
              ctx.sound('move');
              p.chooseStage(list[i]!);
            }
            if (n.confirm) {
              ctx.sound('start');
              p.chooseStage(list[stageIdx]!);
              p.confirmStage();
              return;
            }
          }
          if (n.back) {
            ctx.sound('back');
            p.lock(false);
          }
          return;
        }
        case 'match':
          if (!v.leaveAsk) return;
          if (n.confirm) {
            ctx.sound('back');
            p.leave();
          } else if (n.back || n.start) {
            ctx.sound('confirm');
            p.resume();
          }
          return;
        case 'rematch':
          if (n.back) {
            ctx.sound('back');
            p.leave();
          }
          return;
        case 'countdown':
          return;
        case 'error': {
          errMenu.items[1]!.enabled = v.desync !== null;
          if (!settled(ctx, 0.6)) return;
          if (errMenu.step(n)) ctx.sound('move');
          if (n.back) {
            ctx.sound('back');
            p.leave();
            return;
          }
          if (!n.confirm) return;
          ctx.sound('confirm');
          if (errMenu.current.id === 'log') p.saveLog();
          else p.leave();
          return;
        }
      }
    },
    draw(ctx) {
      const cv = ctx.cv;
      const p = port(ctx);
      if (!p) return;
      const v = p.view;
      if (v.phase === 'match') {
        if (v.leaveAsk) drawLeaveAsk(ctx);
        return;
      }
      backdrop(cv, 'bg:online', (bg) => {
        scrim(bg, 0.7, 0.55, 0.8);
        vignette(bg);
      });
      const right =
        v.transport === 'local'
          ? 'LOCAL TEST LINK'
          : v.pingMs !== null
            ? `PING ${Math.round(v.pingMs)} MS  DELAY ${v.delay}`
            : v.role
              ? v.role === 'host'
                ? 'HOST  P1'
                : 'GUEST  P2'
              : '';
      header(ctx, 'ONLINE', '온라인', right);
      switch (v.phase) {
        case 'menu':
          drawMenu(ctx, v, menu);
          break;
        case 'code':
          drawCode(ctx);
          break;
        case 'creating':
          drawStatus(ctx, 'CREATING A ROOM', '방 만드는 중', v);
          break;
        case 'connecting':
          drawStatus(
            ctx,
            v.role === 'host' ? 'YOUR FRIEND IS HERE: CONNECTING' : `JOINING ROOM ${v.code ?? ''}`,
            '연결 중',
            v,
          );
          break;
        case 'waiting':
          drawWaiting(ctx, v);
          break;
        case 'select':
        case 'stage':
          drawSelect(ctx, p, v, cursor, stageIdx);
          break;
        case 'countdown':
          drawCountdown(ctx, p, v);
          break;
        case 'rematch':
          drawStatus(
            ctx,
            v.peerWantsRematch ? 'STARTING' : 'WAITING FOR YOUR OPPONENT TO ACCEPT',
            '재대결 대기',
            v,
          );
          footer(ctx, [{ chip: promptLabels(ctx).back, text: 'LEAVE' }]);
          break;
        case 'error':
          // the log entry only exists for a desync
          drawError(ctx, v, v.desync ? errMenu : errOnly);
          break;
      }
      if (v.reconnecting > 0) drawReconnect(cv, v.reconnecting);
    },
  };
}

function drawMenu(ctx: UICtx, v: OnlineView, menu: Menu): void {
  const cv = ctx.cv;
  pillar(cv, 150, 60, 490, 300, 0.7, 60);
  drawText(cv, 'CHALLENGE A FRIEND', LOGICAL_W / 2, 92, {
    color: C.text,
    align: 'center',
    tracking: 2,
    scale: 2,
    shadow: alpha(C.void, 0.85),
  });
  drawText(cv, '친구에게 도전', LOGICAL_W / 2, 118, { color: ACCENT.light, align: 'center' });
  drawCentreMenu(ctx, menu, LOGICAL_W / 2, 160, 24, ACCENT);
  if (v.transport === 'off') {
    drawText(cv, 'ONLINE PLAY IS NOT SET UP YET', LOGICAL_W / 2, 250, {
      color: C.gold,
      align: 'center',
      tracking: 1,
    });
    drawText(cv, '온라인 준비 중', LOGICAL_W / 2, 264, { color: C.dim, align: 'center' });
  } else {
    drawText(cv, 'ONE PLAYER CREATES A ROOM AND SENDS THE LINK OR THE CODE', LOGICAL_W / 2, 250, {
      color: C.dim,
      font: 'micro',
      align: 'center',
      tracking: 1,
    });
    drawText(cv, 'THE HOST PLAYS P1 AND PICKS THE STAGE', LOGICAL_W / 2, 260, {
      color: C.dim,
      font: 'micro',
      align: 'center',
      tracking: 1,
    });
  }
  footer(ctx, confirmBack(ctx, 'SELECT', 'BACK'));
}

function drawCode(ctx: UICtx): void {
  const cv = ctx.cv;
  pillar(cv, 130, 60, 510, 300, 0.7, 60);
  drawText(cv, 'ENTER THE ROOM CODE', LOGICAL_W / 2, 84, {
    color: C.text,
    align: 'center',
    tracking: 2,
  });
  drawText(cv, '방 코드 입력', LOGICAL_W / 2, 98, { color: ACCENT.light, align: 'center' });
  const cw = 34;
  const gap = 8;
  const total = ROOM_CODE_LENGTH * cw + (ROOM_CODE_LENGTH - 1) * gap;
  const x0 = Math.floor((LOGICAL_W - total) / 2);
  const y = 130;
  const cur = Math.min(typed.buf.length, ROOM_CODE_LENGTH - 1);
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
    const x = x0 + i * (cw + gap);
    const focus = i === cur || (typed.buf.length === ROOM_CODE_LENGTH && i === ROOM_CODE_LENGTH - 1);
    panel(cv, x, y, cw, 42, {
      fill: alpha(C.ink0, 0.9),
      border: focus ? ACCENT.base : C.line1,
      accent: focus ? ACCENT.light : C.line1,
      shade: false,
    });
    const ch = typed.buf[i];
    if (ch) drawText(cv, ch, x + cw / 2, y + 11, { color: C.white, align: 'center', scale: 3 });
    else if (focus && Math.floor(ctx.t * 2.5) % 2 === 0) cv.rect(x + 9, y + 32, cw - 18, 2, ACCENT.base);
  }
  const typedRecently = performance.now() - typed.at < 400;
  drawText(cv, 'TYPE IT, OR PASTE THE LINK (CTRL+V)', LOGICAL_W / 2, 190, {
    color: typedRecently ? C.soft : C.dim,
    font: 'micro',
    align: 'center',
    tracking: 1,
  });
  drawText(cv, 'A PAD: UP / DOWN CHANGES THE LETTER, RIGHT ADDS ONE', LOGICAL_W / 2, 200, {
    color: C.dim,
    font: 'micro',
    align: 'center',
    tracking: 1,
  });
  drawText(cv, `LETTERS ${ROOM_ALPHABET.slice(0, 15)}  ${ROOM_ALPHABET.slice(15)}`, LOGICAL_W / 2, 214, {
    color: C.line2,
    font: 'micro',
    align: 'center',
    tracking: 1,
  });
  footer(ctx, [
    { chip: 'ENTER', text: 'JOIN', dim: typed.buf.length !== ROOM_CODE_LENGTH },
    { chip: 'ESC', text: 'BACK' },
  ]);
}

function drawStatus(ctx: UICtx, en: string, ko: string, v: OnlineView): void {
  const cv = ctx.cv;
  pillar(cv, 110, 90, 530, 260, 0.7, 60);
  const dots = '.'.repeat(1 + (Math.floor(ctx.t * 3) % 3));
  drawText(cv, en + dots, LOGICAL_W / 2, 150, { color: C.text, align: 'center', tracking: 1 });
  drawText(cv, ko, LOGICAL_W / 2, 166, { color: ACCENT.light, align: 'center' });
  if (v.code)
    drawText(cv, `ROOM ${v.code}`, LOGICAL_W / 2, 196, { color: C.dim, align: 'center', tracking: 3 });
  if (v.phase !== 'rematch') footer(ctx, [{ chip: promptLabels(ctx).back, text: 'CANCEL' }]);
}

function drawWaiting(ctx: UICtx, v: OnlineView): void {
  const cv = ctx.cv;
  pillar(cv, 60, 50, 580, 310, 0.75, 60);
  drawText(cv, 'ROOM CODE', LOGICAL_W / 2, 70, { color: C.dim, align: 'center', tracking: 2 });
  drawText(cv, '방 코드', LOGICAL_W / 2, 82, { color: C.celadonDeep, align: 'center' });
  const code = v.code ?? '------';
  drawText(cv, code.split('').join(' '), LOGICAL_W / 2, 104, {
    color: C.white,
    align: 'center',
    scale: 4,
    shadow: alpha(C.void, 0.9),
  });
  drawText(cv, 'OR SEND THIS LINK', LOGICAL_W / 2, 160, { color: C.dim, align: 'center', tracking: 1 });
  const link = v.link ?? '';
  const lw = measureText(link);
  if (lw <= LOGICAL_W - 60) drawText(cv, link, LOGICAL_W / 2, 176, { color: ACCENT.light, align: 'center' });
  else drawText(cv, link, LOGICAL_W / 2, 178, { color: ACCENT.light, align: 'center', font: 'micro' });
  if (v.copied !== null)
    drawText(cv, v.copied ? 'LINK COPIED' : 'COPY FAILED: SELECT THE CODE ABOVE', LOGICAL_W / 2, 194, {
      color: v.copied ? C.ok : C.danger,
      font: 'micro',
      align: 'center',
      tracking: 1,
    });
  const dots = '.'.repeat(1 + (Math.floor(ctx.t * 3) % 3));
  drawText(cv, `WAITING FOR YOUR FRIEND${dots}`, LOGICAL_W / 2, 226, {
    color: C.soft,
    align: 'center',
    tracking: 1,
  });
  drawText(cv, '친구를 기다리는 중', LOGICAL_W / 2, 240, { color: C.celadonDeep, align: 'center' });
  if (v.transport === 'local')
    drawText(cv, 'LOCAL TEST: OPEN THE LINK IN ANOTHER TAB OF THIS BROWSER', LOGICAL_W / 2, 262, {
      color: C.gold,
      font: 'micro',
      align: 'center',
      tracking: 1,
    });
  const p = promptLabels(ctx);
  footer(ctx, [
    { chip: p.confirm, text: 'COPY LINK' },
    { chip: p.back, text: 'CANCEL' },
  ]);
}

function drawSelect(ctx: UICtx, p: OnlineUiPort, v: OnlineView, cursor: number, stageIdx: number): void {
  const cv = ctx.cv;
  const ts = p.titans;
  const me: 0 | 1 = v.role === 'guest' ? 1 : 0;
  const them: 0 | 1 = me === 0 ? 1 : 0;
  const pickOf = (s: 0 | 1): TitanId | null => (s === me ? v.myPick : v.peerPick);
  const lockOf = (s: 0 | 1): boolean => (s === me ? v.myLocked : v.peerLocked);
  // the two players' panels
  for (const s of [0, 1] as const) {
    const x = s === 0 ? 8 : LOGICAL_W - 8 - 190;
    const y = 44;
    const col = SLOT_COL[s];
    const lock = lockOf(s);
    panel(cv, x, y, 190, 150, {
      accent: col,
      border: lock ? col : C.line1,
      fill: alpha(C.ink1, 0.88),
    });
    cv.rect(x + 8, y + 8, 22, 12, alpha(col, lock ? 1 : 0.22));
    drawText(cv, `P${s + 1}`, x + 19, y + 9, { color: lock ? C.void : col, font: 'micro', align: 'center' });
    drawText(cv, s === me ? 'YOU' : 'FRIEND', x + 36, y + 11, { color: col, font: 'micro', tracking: 1 });
    if (lock) drawText(cv, 'LOCKED', x + 182, y + 11, { color: col, font: 'micro', align: 'right' });
    const id = pickOf(s);
    if (id) {
      drawTitanPortrait(ctx, id, x + 49, y + 26, 92, { flip: s === 1, phase: s * 1.7 });
      const info = ctx.titan(id);
      drawText(cv, info.name.toUpperCase(), x + 95, y + 124, {
        color: C.white,
        align: 'center',
        tracking: 1,
      });
      drawText(cv, info.nameKo, x + 95, y + 136, { color: accentRamp(info.accent).light, align: 'center' });
    } else {
      drawText(cv, 'CHOOSING...', x + 95, y + 70, { color: C.dim, align: 'center', tracking: 1 });
    }
  }
  void them;
  // the grid (compact: tiles centred in the middle column)
  const grid = gridOf(ts.length);
  const scale = 0.62;
  const tile = Math.round(grid.tile * scale);
  const g0 = grid.pos(0);
  ts.forEach((id, i) => {
    const pos = grid.pos(i);
    const x = Math.round(LOGICAL_W / 2 + (pos.x + grid.tile / 2 - LOGICAL_W / 2) * scale - tile / 2);
    const y = Math.round(58 + (pos.y - g0.y) * scale);
    panel(cv, x, y, tile, tile, { fill: alpha(C.ink0, 0.85), border: C.line0, shade: false });
    const spr = portraitSprite(ctx, id, tile - 6);
    if (spr) cv.blit(spr, x + 3, y + 3);
    const mine = v.phase === 'select' ? ts[cursor] === id : v.myPick === id;
    const theirs = v.peerPick === id;
    if (mine) cv.corners(x - 2, y - 2, tile + 4, tile + 4, SLOT_COL[me], v.myLocked ? 7 : 5);
    if (theirs) cv.corners(x - 4, y - 4, tile + 8, tile + 8, SLOT_COL[them], v.peerLocked ? 7 : 4);
  });
  const by = 214;
  if (v.phase === 'select') {
    const msg = v.myLocked ? (v.peerLocked ? 'BOTH READY' : 'WAITING FOR YOUR FRIEND') : 'CHOOSE YOUR TITAN';
    drawText(cv, msg, LOGICAL_W / 2, by, { color: C.soft, align: 'center', tracking: 2 });
    drawText(cv, '타이탄 선택', LOGICAL_W / 2, by + 13, { color: C.celadonDeep, align: 'center' });
    const pl = promptLabels(ctx);
    footer(
      ctx,
      v.myLocked
        ? [{ chip: pl.back, text: 'CHANGE' }]
        : [
            { chip: pl.confirm, text: 'LOCK IN' },
            { chip: pl.back, text: 'LEAVE' },
          ],
    );
  } else {
    // stage: the host picks, the guest watches the choice
    const list: (StageId | 'random')[] = ['random', ...p.stages];
    const host = v.role === 'host';
    drawText(cv, host ? 'CHOOSE THE STAGE' : 'THE HOST IS CHOOSING THE STAGE', LOGICAL_W / 2, 206, {
      color: C.soft,
      align: 'center',
      tracking: 2,
    });
    const shown = host ? stageIdx : Math.max(0, list.indexOf(v.stage));
    const rows = Math.min(list.length, 5);
    const start = Math.max(0, Math.min(list.length - rows, shown - 2));
    for (let k = 0; k < rows; k++) {
      const i = start + k;
      const id = list[i]!;
      const info = id === 'random' ? null : ctx.deps.stages.find((s) => s.id === id);
      const name = id === 'random' ? 'RANDOM' : (info?.name ?? id).toUpperCase();
      const ko = id === 'random' ? '무작위' : (info?.nameKo ?? '');
      const y = 222 + k * 18;
      const focus = i === shown;
      if (focus) cv.rect(LOGICAL_W / 2 - 120, y - 3, 240, 15, alpha(ACCENT.deep, 0.8));
      drawText(cv, name, LOGICAL_W / 2 - 8, y, {
        color: focus ? C.white : C.mid,
        align: 'right',
        tracking: 1,
      });
      drawText(cv, ko, LOGICAL_W / 2 + 8, y - 1, { color: focus ? ACCENT.light : C.dim });
      if (focus && host) drawIcon(cv, 'chevron', LOGICAL_W / 2 - 128, y, ACCENT.base);
    }
    const pl = promptLabels(ctx);
    footer(
      ctx,
      host
        ? [
            { chip: pl.confirm, text: 'FIGHT' },
            { chip: pl.back, text: 'CHANGE TITAN' },
          ]
        : [{ chip: pl.back, text: 'CHANGE TITAN' }],
    );
  }
}

function drawCountdown(ctx: UICtx, p: OnlineUiPort, v: OnlineView): void {
  const cv = ctx.cv;
  pillar(cv, 60, 50, 580, 310, 0.7, 60);
  const me: 0 | 1 = v.role === 'guest' ? 1 : 0;
  const a = me === 0 ? v.myPick : (v.peerPick ?? v.myPick);
  const b = me === 1 ? v.myPick : (v.peerPick ?? v.myPick);
  drawTitanPortrait(ctx, a, 110, 110, 110, {});
  drawTitanPortrait(ctx, b, LOGICAL_W - 220, 110, 110, { flip: true, phase: 1.7 });
  drawText(cv, ctx.titan(a).name.toUpperCase(), 165, 228, { color: C.p1, align: 'center', tracking: 1 });
  drawText(cv, ctx.titan(b).name.toUpperCase(), LOGICAL_W - 165, 228, {
    color: C.p2,
    align: 'center',
    tracking: 1,
  });
  drawText(cv, 'VS', LOGICAL_W / 2, 150, { color: C.soft, align: 'center', scale: 2, tracking: 2 });
  const n = Math.max(1, Math.ceil(v.countdown));
  drawText(cv, String(n), LOGICAL_W / 2, 182, {
    color: C.white,
    align: 'center',
    scale: 4,
    shadow: alpha(C.void, 0.9),
  });
  const st = v.stage === 'random' ? null : ctx.deps.stages.find((s) => s.id === v.stage);
  if (st)
    drawText(cv, st.name.toUpperCase(), LOGICAL_W / 2, 250, { color: C.dim, align: 'center', tracking: 2 });
  drawText(cv, `INPUT DELAY ${v.delay} TICKS (${Math.round((v.delay * 1000) / 60)} MS)`, LOGICAL_W / 2, 268, {
    color: C.line2,
    font: 'micro',
    align: 'center',
    tracking: 1,
  });
  void p;
}

function drawError(ctx: UICtx, v: OnlineView, menu: Menu): void {
  const cv = ctx.cv;
  pillar(cv, 70, 60, 570, 300, 0.8, 60);
  const e = v.error ?? { en: 'STOPPED', ko: '중지' };
  drawText(cv, e.en, LOGICAL_W / 2, 96, { color: C.danger, align: 'center', tracking: 2, shadow: C.void });
  drawText(cv, e.ko, LOGICAL_W / 2, 112, { color: C.soft, align: 'center' });
  let y = 138;
  if (e.detail) {
    drawText(cv, e.detail.toUpperCase(), LOGICAL_W / 2, y, { color: C.mid, font: 'micro', align: 'center' });
    y += 12;
  }
  if (v.desync) {
    drawText(cv, `FIRST DIFFERENT TICK ${v.desync.tick}`, LOGICAL_W / 2, y, {
      color: C.soft,
      align: 'center',
      tracking: 1,
    });
    drawText(
      cv,
      'THE FULL REPORT IS IN THE CONSOLE (F12). SAVE IT AND SEND IT TO THE TEAM',
      LOGICAL_W / 2,
      y + 14,
      {
        color: C.dim,
        font: 'micro',
        align: 'center',
        tracking: 1,
      },
    );
  }
  drawCentreMenu(ctx, menu, LOGICAL_W / 2, 200, 22, accentRamp('#e0705f'));
  footer(ctx, confirmBack(ctx, 'SELECT', 'TITLE'));
}

function drawLeaveAsk(ctx: UICtx): void {
  const cv = ctx.cv;
  const w = 260;
  const h = 64;
  const x = (LOGICAL_W - w) >> 1;
  const y = 120;
  panel(cv, x, y, w, h, { accent: C.danger, border: C.line1, fill: alpha(C.ink1, 0.94) });
  drawText(cv, 'LEAVE THE MATCH?', LOGICAL_W / 2, y + 12, { color: C.text, align: 'center', tracking: 2 });
  drawText(cv, '대전을 나갈까요? 상대는 계속 싸우는 중', LOGICAL_W / 2, y + 26, {
    color: C.dim,
    align: 'center',
  });
  const pl = promptLabels(ctx);
  drawText(cv, `${pl.confirm} LEAVE    ${pl.back} KEEP FIGHTING`, LOGICAL_W / 2, y + 46, {
    color: C.soft,
    font: 'micro',
    align: 'center',
    tracking: 1,
  });
}

function drawReconnect(cv: PixelCanvas, secs: number): void {
  const w = 200;
  const x = (LOGICAL_W - w) >> 1;
  cv.rect(x, 59, w, 18, alpha(C.void, 0.85));
  cv.frame(x, 59, w, 18, C.gold);
  drawText(cv, `CONNECTION LOST  RECONNECTING ${secs}`, LOGICAL_W / 2, 64, {
    color: C.gold,
    font: 'micro',
    align: 'center',
    tracking: 1,
  });
}

/**
 * In-match netplay readout (the app draws it over the fight): ping and input delay in a corner, and a "waiting" notice
 * when the sim is held for the opponent's input, or the reconnect countdown when the link is down.
 */
export function drawNetHud(cv: PixelCanvas, v: Readonly<OnlineView>): void {
  cv.clear(0);
  const ping = v.pingMs !== null ? `${Math.round(v.pingMs)}MS` : '--';
  const s = `PING ${ping}  D${v.delay}`;
  const good = v.pingMs === null || v.pingMs < 80 ? C.ok : v.pingMs < 160 ? C.gold : C.danger;
  // centred just under the round clock (the corners hold the portraits and the ULT bars)
  const w = measureText(s, { font: 'micro', tracking: 1 }) + 10;
  const x = (LOGICAL_W - w) >> 1;
  const y = 47;
  cv.rect(x, y, w, 9, alpha(C.void, 0.6));
  cv.rect(x + 3, y + 3, 3, 3, good);
  drawText(cv, s, x + 8, y + 2, { color: C.soft, font: 'micro', tracking: 1 });
  if (v.reconnecting > 0) drawReconnect(cv, v.reconnecting);
  else if (v.waiting > 20) {
    const t = 'WAITING FOR OPPONENT';
    const tw = measureText(t, { font: 'micro', tracking: 1 }) + 12;
    cv.rect((LOGICAL_W - tw) >> 1, 59, tw, 11, alpha(C.void, 0.75));
    drawText(cv, t, LOGICAL_W / 2, 62, { color: C.gold, font: 'micro', align: 'center', tracking: 1 });
  }
}
