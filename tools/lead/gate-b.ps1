# Gate B capture set (real time, true 1080p full screen, WJ's GPU). Resumable: finished captures are skipped.
# Run on a QUIET machine (no tests/tournaments): it takes over the screen for ~15 minutes.
# Flash metrics ride along in every run: the renderer reads its mean luminance back asynchronously (no canvas read-back).
$ErrorActionPreference = 'Continue'
$env:Path = [System.Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path','User')
$o = '--out=evidence/gate-b', '--strips-out=docs/gates/evidence/gate-b'
npx vite build --logLevel error
# clips (clean picture) — classic footwork, orbit, orbit + depth offset, orbit + sharp-bilinear sprite push
npx tsx tools/lead/rtcapture.ts aivai --name=aivai-classic --overlay=0 @o
npx tsx tools/lead/rtcapture.ts aivai --name=aivai-orbit --overlay=0 --flags=orbit=1 @o
npx tsx tools/lead/rtcapture.ts aivai --name=aivai-orbit-z --overlay=0 --flags=orbit=1,zdepth=1 @o
npx tsx tools/lead/rtcapture.ts aivai --name=aivai-orbit-push --overlay=0 --flags=orbit=1,push=1 @o
npx tsx tools/lead/rtcapture.ts moves-lastone --name=moves-lastone --overlay=0 @o
npx tsx tools/lead/rtcapture.ts moves-planet --name=moves-planet --overlay=0 @o
# input latency with real key events
npx tsx tools/lead/rtcapture.ts latency-lastone --record=0 --overlay=0 @o
npx tsx tools/lead/rtcapture.ts latency-planet --record=0 --overlay=0 @o
# performance and GC (nothing else running; no recording)
npx tsx tools/lead/rtcapture.ts aivai --name=perf --record=0 --overlay=0 @o
npx tsx tools/lead/rtcapture.ts aivai --name=perf-orbit --record=0 --overlay=0 --flags=orbit=1 @o
npx tsx tools/lead/rtcapture.ts aivai --name=gc --seconds=180 --record=0 --lum=0 --overlay=0 --trace=1 @o
