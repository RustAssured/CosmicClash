#!/usr/bin/env bash
# Rebuild and (re)start the production preview on :4173 (used by evidence tools). Usage: tools/lead/serve.sh
cd "$(dirname "$0")/../.."
if [ -f .scratch/preview.pid ]; then kill "$(cat .scratch/preview.pid)" 2>/dev/null; sleep 1; fi
npx vite build >.scratch/build.log 2>&1 || { tail -20 .scratch/build.log; exit 1; }
nohup npx vite preview --port 4173 --strictPort >.scratch/preview.log 2>&1 &
echo $! > .scratch/preview.pid
sleep 3
curl -s -o /dev/null -w "preview up: %{http_code}\n" http://localhost:4173/
