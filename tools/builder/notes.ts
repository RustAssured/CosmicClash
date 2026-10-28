/**
 * The motion studio's notes (dev/builder/studio.ts): feedback pinned to one frame of a move, kept in the titan's own
 * docs/titans/<id>/NOTES.md as a task list (with the frame beside it in notes/), so the next session with Claude starts from
 * "work through docs/titans/<id>/NOTES.md". Pure text in, text out: the bridge (plugin.ts) does the files.
 *
 *   - [ ] **Snap** (forward) · tick 14, active 3/4 · 2026-10-25: reads like a cord ![frame](notes/20261025-101500-t14.png)
 */

export interface Note {
  done: boolean;
  /** What it is about: the move and aim, or "Idle". */
  title: string;
  /** Where in the clip (ticks from the start of the studio's run) and the move's phase there, e.g. "active 3/4". */
  tick: number;
  phase: string;
  date: string;
  text: string;
  /** The frame's file name under notes/ (null = none). */
  image: string | null;
}

export const notesHeader = (id: string): string =>
  `# ${id}: notes from the motion studio\n\n` +
  `Feedback pinned to frames in the titan builder's studio. The open ones are tasks for Claude: ask it to "work through\n` +
  `docs/titans/${id}/NOTES.md". Each is ticked off when it is done.\n\n`;

/** One line of free text: no line breaks or control characters, no markdown that would break the list item. */
export function cleanText(s: string, max = 2000): string {
  return s
    .replace(/\r?\n+/g, ' / ')
    .replace(/[\p{Cc}]/gu, '')
    .replace(/!\[/g, '[')
    .trim()
    .slice(0, max);
}

export function noteLine(n: Note): string {
  const where = `tick ${n.tick}${n.phase ? `, ${n.phase}` : ''}`;
  const img = n.image ? ` ![frame](notes/${n.image})` : '';
  return `- [${n.done ? 'x' : ' '}] **${cleanText(n.title, 80)}** · ${where} · ${n.date}: ${cleanText(n.text)}${img}`;
}

const LINE =
  /^- \[( |x)\] \*\*(.+?)\*\* · tick (\d+)(?:, ([^·]+?))? · (\d{4}-\d{2}-\d{2}): (.*?)(?: !\[frame\]\(notes\/([\w.-]+)\))?$/;

export function parseNotes(md: string): Note[] {
  const out: Note[] = [];
  for (const line of md.split('\n')) {
    const m = LINE.exec(line);
    if (!m) continue;
    out.push({
      done: m[1] === 'x',
      title: m[2]!,
      tick: +m[3]!,
      phase: m[4] ?? '',
      date: m[5]!,
      text: m[6]!,
      image: m[7] ?? null,
    });
  }
  return out;
}

/** Add a note at the end (a new file starts with its header). */
export function appendNote(md: string, id: string, n: Note): string {
  const base = md.trim() ? (md.endsWith('\n') ? md : md + '\n') : notesHeader(id);
  return base + noteLine(n) + '\n';
}

/** Tick note `index` (in `parseNotes` order) done or open again; other lines are kept as they are. */
export function setDone(md: string, index: number, done: boolean): string {
  let k = -1;
  return md
    .split('\n')
    .map((line) => {
      if (!LINE.test(line)) return line;
      k++;
      return k === index ? line.replace(/^- \[( |x)\]/, `- [${done ? 'x' : ' '}]`) : line;
    })
    .join('\n');
}
