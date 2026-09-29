import { LOGICAL_W } from '@/contracts';
import type { ConfirmMode, LabelMode } from '@/input';
import { C, accentRamp, alpha } from '../pixel/palette';
import { drawIcon, panel } from '../pixel/shapes';
import { drawText, measureText } from '../pixel/text';
import {
  Menu,
  confirmBack,
  footer,
  header,
  scrim,
  slider,
  vignette,
  type MenuItem,
  type Screen,
  type UICtx,
  backdrop,
} from './kit';

const ACCENT = accentRamp('#a8bdb2');

const LABEL_MODES: LabelMode[] = ['auto', 'nintendo', 'xbox', 'playstation'];
const CONFIRM_MODES: ConfirmMode[] = ['label', 'positional'];
const QUALITY = ['LOW', 'MEDIUM', 'HIGH'];

interface Row extends MenuItem {
  kind: 'volume' | 'deadzone' | 'enum' | 'rumble' | 'link';
}

/** Options: volumes, deadzone, label mode, confirm mode, rumble, quality, and a way into the key/button remap. */
export function createOptionsScreen(): Screen {
  const rows: Row[] = [
    { id: 'master', en: 'MASTER VOLUME', ko: '전체 음량', kind: 'volume' },
    { id: 'music', en: 'MUSIC', ko: '음악', kind: 'volume' },
    { id: 'sfx', en: 'EFFECTS', ko: '효과음', kind: 'volume' },
    { id: 'deadzone', en: 'STICK DEADZONE', ko: '스틱 데드존', kind: 'deadzone' },
    { id: 'labels', en: 'BUTTON LABELS', ko: '버튼 표기', kind: 'enum' },
    { id: 'confirm', en: 'CONFIRM BUTTON', ko: '확인 버튼', kind: 'enum' },
    { id: 'rumble', en: 'RUMBLE', ko: '진동', kind: 'rumble' },
    { id: 'quality', en: 'GRAPHICS QUALITY', ko: '화질', kind: 'enum' },
    { id: 'keys', en: 'CONTROLS & REMAP', ko: '조작 설정', kind: 'link' },
  ];
  const menu = new Menu(rows);

  const emitVolume = (ctx: UICtx): void => {
    const s = ctx.settings;
    ctx.emit({ type: 'setVolume', master: s.master / 10, music: s.music / 10, sfx: s.sfx / 10 });
  };

  const adjust = (ctx: UICtx, row: Row, dir: -1 | 1): void => {
    const s = ctx.settings;
    const inp = ctx.input;
    switch (row.id) {
      case 'master':
      case 'music':
      case 'sfx': {
        const k = row.id as 'master' | 'music' | 'sfx';
        s[k] = Math.max(0, Math.min(10, s[k] + dir));
        emitVolume(ctx);
        ctx.saveSettings();
        ctx.sound('tick');
        break;
      }
      case 'deadzone':
        inp.updateSettings({
          deadzone:
            Math.round(Math.max(0.05, Math.min(0.45, inp.settings.deadzone + dir * 0.01)) * 100) / 100,
        });
        ctx.sound('tick');
        break;
      case 'rumble':
        inp.updateSettings({
          rumble: Math.round(Math.max(0, Math.min(1, inp.settings.rumble + dir * 0.1)) * 10) / 10,
        });
        ctx.sound('tick');
        break;
      case 'labels': {
        const i = LABEL_MODES.indexOf(inp.settings.labelMode);
        inp.updateSettings({ labelMode: LABEL_MODES[(i + dir + LABEL_MODES.length) % LABEL_MODES.length]! });
        ctx.sound('tick');
        break;
      }
      case 'confirm': {
        const i = CONFIRM_MODES.indexOf(inp.settings.confirmMode);
        inp.updateSettings({
          confirmMode: CONFIRM_MODES[(i + dir + CONFIRM_MODES.length) % CONFIRM_MODES.length]!,
        });
        ctx.sound('tick');
        break;
      }
      case 'quality': {
        s.quality = ((s.quality + dir + 3) % 3) as 0 | 1 | 2;
        ctx.deps.onQuality?.(s.quality);
        ctx.saveSettings();
        ctx.sound('tick');
        break;
      }
    }
  };

  const valueText = (ctx: UICtx, row: Row): string => {
    const inp = ctx.input.settings;
    switch (row.id) {
      case 'master':
        return `${ctx.settings.master * 10}`;
      case 'music':
        return `${ctx.settings.music * 10}`;
      case 'sfx':
        return `${ctx.settings.sfx * 10}`;
      case 'deadzone':
        return `${Math.round(inp.deadzone * 100)}%`;
      case 'rumble':
        return inp.rumble <= 0 ? 'OFF' : `${Math.round(inp.rumble * 100)}%`;
      case 'labels':
        return inp.labelMode === 'auto' ? 'AUTO' : inp.labelMode.toUpperCase();
      case 'confirm':
        return inp.confirmMode === 'label' ? 'LABEL (A / CROSS)' : 'POSITION (BOTTOM)';
      case 'quality':
        return QUALITY[ctx.settings.quality]!;
      default:
        return '';
    }
  };

  const frac = (ctx: UICtx, row: Row): number | null => {
    switch (row.id) {
      case 'master':
        return ctx.settings.master / 10;
      case 'music':
        return ctx.settings.music / 10;
      case 'sfx':
        return ctx.settings.sfx / 10;
      case 'deadzone':
        return (ctx.input.settings.deadzone - 0.05) / 0.4;
      case 'rumble':
        return ctx.input.settings.rumble;
      default:
        return null;
    }
  };

  return {
    enter() {
      menu.set(0);
    },
    update(ctx) {
      const n = ctx.nav;
      if (menu.step(n)) ctx.sound('move');
      const row = menu.current as Row;
      if (n.left) adjust(ctx, row, -1);
      else if (n.right) adjust(ctx, row, 1);
      if (n.back || n.start) {
        ctx.sound('back');
        ctx.pop();
      } else if (n.confirm) {
        if (row.kind === 'link') {
          ctx.sound('confirm');
          ctx.push('controller', { tab: 'remap' });
        } else if (row.kind === 'enum') adjust(ctx, row, 1);
      }
    },
    draw(ctx) {
      const cv = ctx.cv;
      backdrop(cv, 'bg:0.72:0.62:0.78:', (bg) => {
        scrim(bg, 0.72, 0.62, 0.78);
        vignette(bg);
      });
      header(ctx, 'OPTIONS', '설정');
      const x0 = 110;
      const w = LOGICAL_W - 220;
      panel(cv, x0 - 16, 48, w + 32, 262, { accent: ACCENT.dim });
      rows.forEach((row, i) => {
        const y = 60 + i * 27;
        const focus = i === menu.index;
        if (focus) {
          cv.rect(x0 - 10, y - 5, w + 20, 23, alpha(C.ink3, 0.9));
          cv.frame(x0 - 10, y - 5, w + 20, 23, ACCENT.dim);
          drawIcon(cv, 'chevron', x0 - 3, y + 3, ACCENT.base);
        }
        drawText(cv, row.en, x0 + 8, y, { color: focus ? C.white : C.soft, tracking: 1 });
        drawText(cv, row.ko ?? '', x0 + 8 + measureText(row.en, { tracking: 1 }) + 10, y, {
          color: focus ? ACCENT.light : C.dim,
        });
        const f = frac(ctx, row);
        const vt = valueText(ctx, row);
        if (f !== null) {
          slider(ctx, x0 + w - 190, y + 4, 130, f, ACCENT, focus);
          drawText(cv, vt, x0 + w - 4, y, { color: focus ? C.white : C.mid, align: 'right', tracking: 1 });
        } else if (row.kind === 'enum') {
          drawText(cv, vt, x0 + w - 24, y, { color: focus ? C.white : C.mid, align: 'right', tracking: 1 });
          if (focus) {
            drawIcon(cv, 'arrowL', x0 + w - 24 - measureText(vt, { tracking: 1 }) - 10, y + 2, ACCENT.base);
            drawIcon(cv, 'arrowR', x0 + w - 16, y + 2, ACCENT.base);
          }
        } else if (row.kind === 'link') {
          drawIcon(cv, 'chevron', x0 + w - 12, y + 2, focus ? ACCENT.base : C.line2);
        }
      });
      footer(ctx, [...confirmBack(ctx, 'CHANGE', 'BACK'), { chip: ['←', '→'], text: 'ADJUST' }]);
    },
  };
}
