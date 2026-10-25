import { describe, expect, it } from 'vitest';
import { appendNote, cleanText, parseNotes, setDone, type Note } from './notes';

const note = (over: Partial<Note> = {}): Note => ({
  done: false,
  title: 'Snap (forward)',
  tick: 14,
  phase: 'active 3/4',
  date: '2026-10-25',
  text: 'reads like a cord',
  image: '20261025-101500-t14.png',
  ...over,
});

describe('motion studio notes', () => {
  it('round-trips through NOTES.md, header first', () => {
    let md = appendNote('', 'remainder', note());
    md = appendNote(
      md,
      'remainder',
      note({ title: 'Idle', tick: 3, phase: '', text: 'swirl faster', image: null }),
    );
    expect(md.startsWith('# remainder: notes from the motion studio')).toBe(true);
    expect(parseNotes(md)).toEqual([
      note(),
      note({ title: 'Idle', tick: 3, phase: '', text: 'swirl faster', image: null }),
    ]);
  });

  it('ticks one note off and leaves the rest of the file alone', () => {
    let md = appendNote('', 'remainder', note());
    md = appendNote(md, 'remainder', note({ text: 'second' }));
    md += '\nsome words written by hand\n';
    const done = setDone(md, 1, true);
    expect(parseNotes(done).map((n) => n.done)).toEqual([false, true]);
    expect(done).toContain('some words written by hand');
    expect(parseNotes(setDone(done, 1, false))[1]!.done).toBe(false);
  });

  it('keeps a note to one safe line', () => {
    expect(cleanText('two\nlines\u0007 and ![img](x)')).toBe('two / lines and [img](x)');
    const md = appendNote('', 'x', note({ text: 'a\nb' }));
    expect(parseNotes(md)[0]!.text).toBe('a / b');
  });
});
