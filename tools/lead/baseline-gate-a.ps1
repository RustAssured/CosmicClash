# Gate A baseline capture set (real time, WJ's GPU). Resumable: finished captures are skipped (delete a JSON to redo).
# Takes over the screen (full-screen Edge) for ~8 minutes.
$ErrorActionPreference = 'Continue'
$o = '--out=evidence/gate-a', '--strips-out=docs/gates/evidence/gate-a'
npx vite build --logLevel error
# 1. the gate clip: 60 s of AI-vs-AI Last One vs Planet, clean picture, flash metering on
npx tsx tools/lead/rtcapture.ts aivai --name=baseline-aivai --overlay=0 @o
# 2–3. isolated moves on an idle foe (commitment, tendrils, wound sequence, camera)
npx tsx tools/lead/rtcapture.ts moves-lastone --name=baseline-moves-lastone --overlay=0 @o
npx tsx tools/lead/rtcapture.ts moves-planet --name=baseline-moves-planet --overlay=0 @o
# 4. performance: no recording, no luminance read-back
npx tsx tools/lead/rtcapture.ts aivai --name=baseline-perf --record=0 --lum=0 --overlay=0 @o
# 5. GC pauses over a 3-minute fight (tracing on, nothing else)
npx tsx tools/lead/rtcapture.ts aivai --name=baseline-gc --seconds=180 --record=0 --lum=0 --overlay=0 --trace=1 @o
