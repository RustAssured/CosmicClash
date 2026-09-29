import { ROUNDS_TO_WIN, ROUND_INTRO_TICKS, type HudState, type MatchApi } from '@/contracts';

/** Big centre-screen text for the current match phase (English + Hangeul where the UI font has it). */
export function announcerText(match: MatchApi): string | null {
  const t = match.phase === 'fight' ? match.roundTicksLeft : 0;
  void t;
  switch (match.phase) {
    case 'intro': {
      if (match.phaseTick < ROUND_INTRO_TICKS * 0.55) {
        const final = match.wins[0] === ROUNDS_TO_WIN - 1 && match.wins[1] === ROUNDS_TO_WIN - 1;
        return final ? 'FINAL ROUND' : `ROUND ${match.round}`;
      }
      return 'FIGHT';
    }
    case 'fight':
      // "FIGHT" lingers briefly after the bell, then the screen is left clear
      return match.phaseTick < 36 ? 'FIGHT' : null;
    case 'ko':
      return 'K.O.';
    case 'timeover':
      return 'TIME';
    case 'roundend':
      return match.phaseTick > 30 ? '승리!' : null;
    case 'matchend':
      return null;
  }
}

/** Build the HUD state the UI draws from (allocation-light: one object per call, reused by the app). */
export function fillHudState(out: HudState, match: MatchApi, training: boolean, paused: boolean): HudState {
  out.match = match;
  out.round = match.round;
  out.wins = match.wins;
  out.roundTicksLeft = match.roundTicksLeft;
  out.phase = match.phase;
  out.announcer = announcerText(match);
  out.training = training;
  out.paused = paused;
  return out;
}
