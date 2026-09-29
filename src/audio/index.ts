export { createAudioEngine, type AudioEngineExt, type AudioEngineOptions } from './engine';
export { UI_TRIM } from './voices/ui';
export { STAGE_MUSIC, MODES } from './dsp/scales';
export { planStep, stepSeconds, STEPS_PER_BAR, type ScoreParams, type StepPlan } from './score/plan';
export { generateImpulseResponse } from './dsp/ir';
export { limiterCurve, hardClipCurve, volumeCurve } from './dsp/math';
export type { TitanVoice, VoiceCtx } from './voices/types';
