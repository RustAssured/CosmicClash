/**
 * Netplay Step 0: the page side of tools/netplay/crossengine.ts. Bundled by esbuild into one script, served with the
 * recordings; runs every recording through the sim with no AI, and posts each result back to the server that served it.
 * Works in any browser (no Playwright needed in the page): open the served URL in Safari or Firefox by hand.
 */
import { setUriAsset } from '@/titans/uri/asset';
import { digest, mathProbe, startReplay, type Recording } from './replay-core';
import { PROBE_EXTRA } from './probe-extra';

const engine = new URLSearchParams(location.search).get('engine') ?? 'browser';
const status = document.getElementById('status')!;
/** Yield to the event loop through a message port: unlike setTimeout, hidden / headless pages do not throttle it. */
const channel = new MessageChannel();
const yieldTask = (): Promise<void> =>
  new Promise((r) => {
    channel.port1.onmessage = () => r();
    channel.port2.postMessage(0);
  });
const post = (path: string, body: unknown): Promise<Response> =>
  fetch(`${path}?engine=${encodeURIComponent(engine)}`, { method: 'POST', body: JSON.stringify(body) });

async function main(): Promise<void> {
  setUriAsset(await (await fetch('uri_rig.bin')).arrayBuffer());
  const recs = (await (await fetch('recordings.json')).json()) as Recording[];
  await post('probe', { ua: navigator.userAgent, probe: mathProbe(PROBE_EXTRA) });
  for (let i = 0; i < recs.length; i++) {
    const rec = recs[i]!;
    status.textContent = `${engine}: ${i + 1} / ${recs.length} ${rec.a} v ${rec.b}`;
    // slices of 120 ticks with a yield between: no engine's hung-script watchdog fires (Firefox's is 10 s)
    const run = startReplay(rec, () => performance.now());
    while (!run.advance(120)) await yieldTask();
    const r = run.result();
    await post('result', {
      i,
      a: r.a,
      b: r.b,
      ticks: r.ticks,
      hashes: Array.from(r.hashes),
      checksums: r.checksums ? Array.from(r.checksums) : null,
      digest: digest(r.hashes),
      final: r.final,
      ms: r.ms,
    });
  }
  status.textContent = `${engine}: done (${recs.length} replays)`;
  await post('done', {});
}

main().catch((e: unknown) => {
  status.textContent = `error: ${String(e)}`;
  void post('error', { error: e instanceof Error ? `${e.message}\n${e.stack}` : String(e) });
});
