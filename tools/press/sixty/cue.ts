/**
 * "WHAT'S LEFT": the 60 s trailer's clock and its score. One grid for picture and sound: the intro runs free on two
 * heartbeats, then everything sits on 90 BPM from the first taiko at 10 s. Cut points in the edit (edl.ts) are these beats.
 */
export const BPM = 90;
export const BEAT = 60 / BPM;
/** The first taiko (the 아득 cut): the grid starts here. */
export const GRID0 = 10;
export const beat = (n: number): number => +(GRID0 + n * BEAT).toFixed(4);

/** Section marks (seconds). */
export const MARK = {
  ah: GRID0, // 아득
  roster: beat(3), // 12.0
  rule: beat(30), // 30.0
  body: beat(38), // 35.33
  snap: beat(46), // 40.67
  hunt: beat(51), // 44.0
  through: beat(57), // 48.0
  fist: beat(65), // 53.33
  black: beat(67), // 54.67
  title: 55,
  sting: 58.4,
  end: 60,
} as const;

/** The roster's cuts: nine titans over 27 beats, accelerating (4 4 3 3 3 3 3 2 2). */
export const ROSTER_BEATS = [4, 4, 3, 3, 3, 3, 3, 2, 2];

export interface CueEvent {
  t: number;
  k:
    | 'heart'
    | 'taiko'
    | 'sub'
    | 'perc'
    | 'bell'
    | 'lowbell'
    | 'boom'
    | 'braam'
    | 'pad'
    | 'drone'
    | 'rumble'
    | 'riser'
    | 'shepard'
    | 'impact'
    | 'suck';
  v?: number;
  d?: number;
  oct?: number;
  pan?: number;
  dur?: number;
  wrong?: boolean;
  chord?: number[];
  lp0?: number;
  lp1?: number;
}

function build(): CueEvent[] {
  const e: CueEvent[] = [];
  const at = (t: number, k: CueEvent['k'], o: Omit<CueEvent, 't' | 'k'> = {}): void => void e.push({ t, k, ...o });

  // ---- I. REFUSAL (0–10): two hearts, out of step; a drone wakes under them -------------------------------------------
  for (let t = 0.4; t < 9.2; t += 1.25) {
    const swell = Math.min(1, 0.45 + t / 9);
    at(t, 'heart', { v: swell, pan: -0.35 });
    at(t + 0.47, 'heart', { v: swell * 0.85, pan: 0.35 });
  }
  at(1.5, 'drone', { dur: 9, v: 0.7 });
  at(2.0, 'pad', { dur: 8.4, chord: [0, 4], oct: -1, v: 0.8, lp0: 140, lp1: 700 });
  // 우리's motif, once: two notes a fifth apart (one per world)
  at(3.2, 'bell', { d: 0, oct: 2, v: 0.8, pan: -0.4, dur: 4 });
  at(4.4, 'bell', { d: 4, oct: 2, v: 0.8, pan: 0.4, dur: 4 });
  // 0:07 the blast hits, the loop swallows it
  at(7.0, 'boom', { v: 0.8, dur: 1.6 });
  at(7.0, 'rumble', { dur: 2.5, v: 0.7 });
  at(7.6, 'suck', { dur: 1.2, v: 1 });
  at(9.0, 'riser', { dur: 1.0, v: 0.8 });

  // ---- 아득 (10): the first taiko -----------------------------------------------------------------------------------
  at(MARK.ah, 'impact', { v: 0.8 });
  at(MARK.ah, 'taiko', { d: 0, oct: 0, v: 1.6 });
  at(MARK.ah, 'lowbell', { d: 0, oct: 0, v: 0.9, dur: 6 });

  // ---- II. ROSTER (12–30): drums build; a slam on every cut ---------------------------------------------------------
  let b = 3;
  for (const [i, n] of ROSTER_BEATS.entries()) {
    const t = beat(b);
    at(t, 'boom', { v: 0.45 + i * 0.04, dur: 1.0 });
    at(t, 'taiko', { d: 0, v: 1.3 });
    if (i % 3 === 0) at(t, 'bell', { d: i % 2 ? 4 : 0, oct: 2, v: 0.5, pan: i % 2 ? 0.4 : -0.4, dur: 3 });
    b += n;
  }
  at(beat(3), 'pad', { dur: 18, chord: [0, 1, 4], oct: -1, v: 0.7, lp0: 200, lp1: 1400 });
  for (let n = 3; n < 30; n++) {
    const t = beat(n);
    const k = (n - 3) / 27; // 0 → 1 across the roster
    at(t, 'sub', { v: 0.5 + 0.5 * k });
    // the groove: low on the bar, the fifth on beat 3, eighths fill in as it builds
    if (n % 4 === 0) at(t, 'taiko', { d: 0, oct: 0, v: 1.0 + 0.4 * k, pan: -0.15 });
    if (n % 4 === 2) at(t, 'taiko', { d: 4, oct: 0, v: 1.0 + 0.5 * k, pan: 0.2 });
    if (k > 0.15) at(t + BEAT / 2, 'taiko', { d: 0, oct: 1, v: 0.5 + 0.5 * k, pan: -0.25 });
    if (k > 0.45) for (let s = 0; s < 4; s++) at(t + (s * BEAT) / 4, 'perc', { v: 0.7 + 0.7 * k, pan: s % 2 ? 0.3 : -0.3 });
  }
  at(beat(27), 'riser', { dur: BEAT * 3, v: 0.9 });

  // ---- III. THE RULE (30–40.67): the wall --------------------------------------------------------------------------
  at(MARK.rule, 'braam', { v: 1, dur: 2.6 });
  at(MARK.rule, 'impact', { v: 0.55 });
  at(MARK.body, 'braam', { v: 1, dur: 1.6 });
  at(beat(41), 'braam', { v: 1.05, dur: 1.6 });
  at(MARK.rule, 'pad', { dur: 10.7, chord: [0, 1, 4], oct: -1, v: 1.1, lp0: 400, lp1: 2200 });
  for (let n = 30; n < 46; n++) {
    const t = beat(n);
    at(t, 'sub', { v: 1 });
    at(t, 'taiko', { d: n % 2 ? 4 : 0, v: 1.1, pan: n % 2 ? 0.2 : -0.2 });
    at(t + BEAT / 2, 'taiko', { d: 0, oct: 1, v: 0.7 });
    for (let s = 0; s < 4; s++) at(t + (s * BEAT) / 4, 'perc', { v: 1.1, pan: s % 2 ? 0.35 : -0.35 });
  }
  at(beat(42), 'shepard', { dur: MARK.snap - beat(42), v: 0.9 });
  at(beat(43), 'riser', { dur: MARK.snap - beat(43), v: 1 });
  // the loop snaps: everything at once, then nothing
  at(MARK.snap, 'impact', { v: 1 });
  at(MARK.snap, 'braam', { v: 0.8, dur: 1.2 });
  // the silence: one heartbeat in it
  at(beat(48), 'heart', { v: 0.7 });

  // ---- IV. THE HUNT (44–54.67) -------------------------------------------------------------------------------------
  at(MARK.hunt, 'heart', { v: 0.9, pan: -0.3 });
  at(MARK.hunt + 0.47, 'heart', { v: 0.85, pan: 0.3 });
  at(beat(53), 'heart', { v: 1, pan: -0.3 });
  at(beat(53) + 0.47, 'heart', { v: 0.95, pan: 0.3 });
  at(MARK.hunt, 'pad', { dur: 10.7, chord: [0, 4], oct: -1, v: 1, lp0: 160, lp1: 2600 });
  at(MARK.hunt, 'bell', { d: 0, oct: 2, v: 0.8, pan: -0.4, dur: 4 });
  at(MARK.hunt + BEAT * 2, 'bell', { d: 4, oct: 2, v: 0.8, pan: 0.4, dur: 4 });
  for (let n = 54; n < 57; n++) at(beat(n), 'taiko', { d: 0, v: 0.5 + (n - 54) * 0.2 });
  for (let n = 57; n < 67; n++) {
    const t = beat(n);
    at(t, 'boom', { v: 0.6, dur: 0.9 });
    at(t, 'taiko', { d: n % 2 ? 4 : 0, v: 1.3 });
    at(t, 'sub', { v: 1 });
    at(t + BEAT / 2, 'taiko', { d: 0, oct: 1, v: 0.9 });
    for (let s = 0; s < 4; s++) at(t + (s * BEAT) / 4, 'perc', { v: 1.2, pan: s % 2 ? 0.35 : -0.35 });
  }
  at(MARK.through, 'braam', { v: 1, dur: 2.4 });
  at(MARK.through, 'shepard', { dur: MARK.black - MARK.through, v: 1.1 });
  at(MARK.fist, 'riser', { dur: MARK.black - MARK.fist, v: 1.2 });
  at(MARK.fist, 'suck', { dur: MARK.black - MARK.fist, v: 1.2 });

  // ---- V. TITLE (55–60) --------------------------------------------------------------------------------------------
  at(MARK.title, 'impact', { v: 1.1 });
  at(MARK.title, 'lowbell', { d: 0, oct: 0, v: 1, dur: 6 });
  at(MARK.title, 'rumble', { dur: 5, v: 0.6 });
  at(MARK.sting, 'heart', { v: 0.8, pan: -0.3 });
  at(MARK.sting + 0.47, 'heart', { v: 0.75, pan: 0.3 });
  at(MARK.sting + 1.05, 'heart', { v: 1.1, wrong: true });
  return e.sort((p, q) => p.t - q.t);
}

export const CUE: CueEvent[] = build();
