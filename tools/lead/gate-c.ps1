# Gate C evidence (real time, true 1080p full screen, WJ's GPU; then deterministic reference clips and the full checks).
# Run on a QUIET machine: the real-time part takes over the screen for ~12 minutes. Resumable (finished captures are skipped).
$ErrorActionPreference = 'Continue'
$env:Path = [System.Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path','User')
$o = '--out=evidence/gate-c', '--strips-out=docs/gates/evidence/gate-c'
npx vite build --logLevel error
# 1. real time, bare (no recording): performance, wounds, flashes, loudness, pacing — both slice arenas, Witness vs Planet
npx tsx tools/lead/rtcapture.ts aivai --name=fight-mausoleum --stage=mausoleum --seconds=180 --record=0 --overlay=0 @o
npx tsx tools/lead/rtcapture.ts aivai --name=fight-shearfield --stage=shearfield --seconds=180 --record=0 --overlay=0 @o
# 2. GC pauses (V8 tracing costs frames: its own run)
npx tsx tools/lead/rtcapture.ts aivai --name=gc-shearfield --stage=shearfield --seconds=180 --record=0 --lum=0 --overlay=0 --trace=1 @o
# 3. input latency with real key events
npx tsx tools/lead/rtcapture.ts latency-lastone --record=0 --overlay=0 @o
npx tsx tools/lead/rtcapture.ts latency-planet --record=0 --overlay=0 @o
# 4. deterministic 60 fps reference clips (what the game draws; no capture artefacts)
foreach ($st in 'mausoleum','shearfield') {
  npx tsx tools/lead/refrender.ts --params="mode=aivai&a=lastone&b=planet&stage=$st&seed=21&ai=4" --seconds=60 --name=witness-planet-$st --out=evidence/gate-c
}
npx tsx tools/lead/refrender.ts --params="mode=training&a=lastone&b=planet&stage=mausoleum&p1=dummy&p2=dummy&seed=3&script0=0:up*200,200:down*240,440:up*200" --seconds=8 --skip=1 --name=passover --out=evidence/gate-c
