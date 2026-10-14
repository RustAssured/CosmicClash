# Netplay Step 1: CHALLENGE A FRIEND (S20)

Online 1v1 by link. One player creates a room and sends a link or a six-character code. The friend opens it, both pick
titans, the host picks the stage, and the match runs peer to peer in **input-delay lockstep**. This follows the Step 0
recommendation (docs/netplay/STEP0.md). The client uses only the browser's own WebRTC: no npm packages.

**Status**
- Built and tested here: the client, the UI, the local loopback and the tests.
- Written but **not deployed**: the Cloudflare worker. WJ deploys it with netplay-worker/README.md, then sets
  `NETPLAY_URL` in `src/net/config.ts`.
- Until then, ONLINE says "ONLINE PLAY IS NOT SET UP YET". The local test mode (§5) works now.

## 1. Transport: one WebRTC connection, two DataChannels

| Channel | Settings | Carries |
|---|---|---|
| `in` (id 1) | `ordered: false, maxRetransmits: 0` | lockstep input packets and pings (binary) |
| `ctl` (id 0) | ordered, reliable | handshake, picks, stage, start, rematch, desync, goodbye (JSON) |

Both channels are pre-negotiated (`negotiated: true`), so they exist on both sides from the start.

**Why the input lane is unreliable.**
- On a reliable, ordered channel, one lost datagram holds back every packet behind it until SCTP retransmits it. That
  takes at least one RTT, and often a 200 ms+ retransmission timeout. Lockstep would freeze for that long.
- Redundancy costs almost nothing here. Every packet repeats all of this peer's inputs that the other side hasn't
  acknowledged yet (4 bytes each). So a lost packet is covered by the next one, 16.7 ms later, and nothing ever waits
  for an old packet.
- Control messages are rare and must arrive in order, so they use the reliable lane.

**Wire format** (`src/net/codec.ts`, little-endian):

```text
INPUT  u8 1 | u8 epoch | u32 ack | u32 first | u8 n | n × (i8 x, i8 y, u16 held) | u32 ckTick | u32 ck | u32 hashTick | u32 hash
PING   u8 2 | u32 id | f64 sentMs        PONG  u8 3 | (the ping echoed)
```

| Field | Meaning |
|---|---|
| input (4 bytes a tick) | The stick quantised to int8 (−127…127) plus the held mask. |
| edges | Not sent: both peers derive pressed / released from consecutive held masks, exactly as the live sources do. |
| PAUSE / TRAINING | Never cross the wire. |
| `ack` | The highest tick of the peer's inputs received without gaps. |
| `epoch` | The match number in the session: a late packet from the previous match is ignored. |
| `ck` | Every packet carries this peer's newest `Match.checksum()`. |
| `hash` | The newest full `Match.hash()`, taken every 60 ticks. |

A packet in steady play is about 40 bytes. At 60 per second, plus a 100 ms heartbeat and two pings a second, that is
about 3 KB/s each way before UDP / DTLS / SCTP overhead.

## 2. Signalling and TURN: `netplay-worker/` (Cloudflare Worker + one Durable Object per room)

| Endpoint | Does |
|---|---|
| `POST /rooms` | Makes a room and returns `{ code, token }`. The code is 6 characters from `ABCDEFGHJKMNPQRSTUVWXYZ23456789` (no 0/O, 1/I/L), drawn with `crypto.getRandomValues` without modulo bias; a code already in use is redrawn. The token is the host's seat. |
| `GET /rooms/:code/ws?role=host\|guest&token=…` | A WebSocket into the room's Durable Object. It relays `{t:'relay', d}` between the two seats: SDP offers / answers and ICE candidates. It sends `joined` (with the seat token, so a dropped socket can reconnect into the same seat), `peer` present / absent, and `error` codes `notfound` / `full` / `badtoken` / `expired` / `ratelimit` / `badrequest`. A `ping` text gets an automatic `pong` (`setWebSocketAutoResponse`), so keepalives don't wake the object. |
| `GET /turn?room=…&token=…` | Short-lived TURN credentials, **for members of a live room only**. Port 53 URLs are dropped, because browsers block that port. Without the secrets it returns public STUN only. |

**TURN credentials.** The worker POSTs `{"ttl": 10800}` (3 hours) to
`https://rtc.live.cloudflare.com/v1/turn/keys/$TURN_KEY_ID/credentials/generate-ice-servers`, with
`Authorization: Bearer $TURN_KEY_API_TOKEN`. Cloudflare answers 201 with `{ iceServers: [...] }`. `TURN_KEY_ID` and
`TURN_KEY_API_TOKEN` are Worker secrets (`wrangler secret put`). They are never in the repo or the client.

**Room lifetime** (Durable Object alarms). A room's storage is deleted (`deleteAll`) when any of these happens:
- no guest joined within 15 minutes;
- both sockets have been gone for 2 minutes;
- the room is 3 hours old.

Nothing else is stored.

**Abuse limits**
- Origins: only `ALLOWED_ORIGINS` (wrangler.toml: the Vercel and Pages sites) plus localhost / 127.0.0.1 on any port.
  This is checked for CORS and for the WebSocket's Origin.
- Per IP, per isolate (best effort): 10 rooms, 30 sockets and 20 TURN requests a minute.
- Per socket: at most 120 messages per 10 s and 16 KB per message; over that, the socket is closed.

**Type-checking without packages.** `npx tsc -p netplay-worker` checks against the minimal stubs in
`netplay-worker/src/env.d.ts`. Nice to have: the devDependency `@cloudflare/workers-types`, with
`"types": ["@cloudflare/workers-types"]` in netplay-worker/tsconfig.json; then delete the stubs.

**Checked against Cloudflare's docs (2026-10-14)**
- The TURN endpoint, the request body, the 201 response with `iceServers`, and the port 53 advice
  (developers.cloudflare.com/realtime/turn/generate-credentials/).
- Durable Objects on the Workers Free plan: SQLite-backed only, hence `new_sqlite_classes` in the migration. Daily
  limits: 100,000 requests and 13,000 GB-s.
- The WebSocket Hibernation API.
- TURN pricing: the first 1,000 GB a month is free (shared with the SFU), then $0.05 per GB.

**Not verified (no account or deploy here)**
- The dashboard path to create a TURN key (Realtime › TURN Server) and its field names.
- Whether TURN needs a payment method on file.
- The exact `iceServers` shape. The worker accepts an array or a single object.
- The upper limit on `ttl`.
- That `getWebSockets(tag)`, `setWebSocketAutoResponse` and `readyState` behave as typed in the stubs.
- That `compatibility_date = "2025-09-01"` is accepted as is.

## 3. Client: `src/net/`

| File | What |
|---|---|
| `config.ts` | `NETPLAY_URL` (empty until WJ deploys), `?net=` override, room codes and links, `buildId()` |
| `codec.ts` | the binary packets, int8 stick quantisation |
| `lockstep.ts` | `Lockstep`: the per-tick input log, delay pre-fill, redundant packets and acks, checksum / hash comparison, `delayFor`, the input-log dump |
| `driver.ts` | `NetMatchDriver`: glue between one `Match` and its `Lockstep` (`beforeStep` / `afterStep`) |
| `online.ts` | `OnlineController`: the session state machine, heartbeat, pings, watchdog and reconnect, desync report |
| `link.ts` / `rtc.ts` / `signal.ts` | the link interface, the WebRTC link, the worker client |
| `loopback.ts` | the in-page loopback pair (fake clock) and the two-tab BroadcastChannel / e2e bridge link, with simulated latency, jitter and loss |
| `ping.ts` | RTT median and jitter (p95 of the deviation) |
| `types.ts` | `OnlineView` / `OnlineUiPort`: all the UI sees |

**Session flow**
1. ONLINE › CREATE ROOM shows the code and the link `…/play/?room=CODE`.
2. The friend opens the link, or picks JOIN and types the code.
3. A WebRTC connection opens.
4. Handshake: each side sends `hello` with `buildId()`, whether its debug panel ever tuned a knob, and its titan list.
   A different build or a tuned tab is refused with a clear screen.
5. Online select: host = P1, guest = P2. Each side's pick and lock are sent as they change.
6. Once both are locked, the host picks a stage (or RANDOM). The guest sees the choice live.
7. The host builds the **full MatchConfig**: seed, stage, both titans, footwork, zdepth, pace, roundSeconds. These come
   from the host's settings, so neither side's own defaults can differ. The host sends it with the agreed delay and the
   epoch.
8. A 3-second countdown, during which both sides start preparing the stage.
9. The lockstep match.
10. Results: REMATCH needs both players and goes back to the online select with the picks kept. TITLE sends a goodbye.

**Build id.** `p1-<commit>`. vite.config.ts defines `__ADEUK_BUILD__`:
- from `VERCEL_GIT_COMMIT_SHA` or `GITHUB_SHA`;
- else from the local `.git` HEAD;
- else `dev`.

So the same commit on Vercel and on Pages can play together.

**Lockstep**
- Ticks are the Match's own.
- Ticks 1…D are pre-filled with empty input on both sides.
- Each loop tick:
  1. Sample this player's device for tick `sim + 1 + D`, quantise it, store it and send the packet.
  2. Step the match only if both slots' inputs for `sim + 1` are present.
- The sim waits and never speeds up. A HUD notice says "WAITING FOR OPPONENT" after 20 waiting ticks.

**Input delay.** `D = ceil((RTT/2 + jitter + 4 ms) / 16.7 ms)`, clamped to 2–6. It is 3 until there are 5 pings. The
host measures it at the stage confirm, and it is fixed for the match. The ping and delay readout sits under the round
clock.

**Desync**
- Each received checksum is compared with this peer's own for that tick, or kept until this peer reaches that tick. The
  same goes for the full hash every 60 ticks.
- On a mismatch:
  - the match halts on both sides;
  - the screen says DESYNC with the first differing tick and both values;
  - the console gets the report: build, role, config, the mismatch, and the whole input log (quantised, both slots)
    with this peer's checksum for every tick;
  - SAVE DESYNC LOG downloads it as JSON.
- `npx tsx tools/netplay/desync-replay.ts A.json [B.json]` replays a report in Node. It says whether each peer's own sim
  diverged from Node, the first tick the peers differ, and whether their input logs agree.

**Disconnects**
- The link counts as down after 2.5 s without a packet, or when the ICE state leaves "connected".
- The grace period is 10 s ("CONNECTION LOST — RECONNECTING n"). If the transport still says it is open, the silence is
  treated as a busy page and the grace period is 60 s: before the first input of a match, and outside a match.
- In WebRTC mode the host rebuilds the peer connection through the room socket every 3 s during the grace period (a
  fresh RTCPeerConnection, `gen`-numbered). The room socket reconnects with its seat token.
- Unacknowledged inputs are simply resent on the new link, so the lockstep resumes where it was.
- After the grace period: "CONNECTION LOST". A goodbye shows "YOUR OPPONENT LEFT".
- Once the match result is decided, a silent peer only blocks a rematch.

**Locked online**
- The debug overlay and every live-tuning knob: nothing is registered, the overlay is forced off, and a tab that ever
  tuned a knob is refused at the handshake.
- PAUSE: in an online match it asks "LEAVE THE MATCH?" and the match keeps running.
- The aftermath freeze: a peer that stopped stepping would hold the other one.

## 4. UI

- **Title:** ONLINE / 온라인 is the last item. Every older menu position is unchanged, and UP from VERSUS wraps
  straight to it. The rows are 2 px tighter so eight fit.
- **`src/ui/screens/online.ts`:**
  - CREATE ROOM / JOIN ROOM;
  - code entry: type it or paste the link; a pad dials letters with up / down and adds one with right;
  - the waiting screen: the code at ×4, the link, confirm copies it;
  - connecting;
  - the online select: both players' panels marked YOU / FRIEND, the grid with both cursors;
  - the host's stage list (the guest sees it);
  - the countdown with the matchup and the input delay;
  - the rematch wait;
  - the LEAVE prompt over a running match;
  - the stop screens.
- **App hooks** (src/app/app.ts): `Session.net`, the two lines around `m.step()` in `tick()`, the ping readout layer,
  and the routing of PAUSE, REMATCH and TITLE. `?room=CODE` opens the join straight away (`openOnlineFromUrl`, called
  from main.ts).

## 5. Tests and the local test mode

| | What it checks | Result |
|---|---|---|
| `src/net/lockstep.test.ts` (vitest) | Two real `Match`es (planet v Witness) in lockstep over the fake link: one-way 35 ms + 0–25 ms jitter, **15 % input-packet loss**, each peer's frame clock jittering ±2 ms with 1 % of frames taking 120 ms. Each slot is played by its own peer's AI. | 900 ticks; identical checksum every tick and identical final `hash()` |
| same file | One peer's world is carved at tick 250 | the desync is caught at tick 250–251 |
| same file | the codec round-trip, quantisation, `delayFor`, room codes and links | pass |
| `e2e/netplay.spec.ts` (Playwright) | Two pages, **two browsers**, `?net=bridge`: the loopback link with the test relaying messages; 25 ± 15 ms, 10 % loss, `netai=4` on both | identical checksum for every tick and identical hash every 60 ticks; 120 ticks by default (`NET_TICKS=600` for longer). 3.7 min here on software GL |

**The local test mode needs no worker.** Add `?net=local` to the address.

```text
npm run dev
Tab 1:  http://localhost:5173/?net=local                → ONLINE › CREATE ROOM (shows the code and a link)
Tab 2:  open that link (http://localhost:5173/?net=local&room=CODE)
```

- The tabs talk over a BroadcastChannel.
- `&netsim=40,10,0.05` adds one-way latency (ms), jitter (ms) and input-packet loss.
- `&host=CODE` opens a room with a fixed code.
- Testing flags: `&netai=1..6` lets the AI play this tab's slot and pick by itself; `&netpick=planet`,
  `&netstage=nursery` and `&netdelay=2..6` fix the pick, the stage and the delay.
- Two tabs in one window share one renderer. Put them in two windows side by side, or the background tab's
  requestAnimationFrame stops (the match then waits, as it would for a real opponent who switched away).

**The e2e uses two browsers.** On software GL, one browser can't render two matches at a useful rate. The
`?net=bridge` link is the BroadcastChannel link with the channel swapped for `window.__adeukBridgeOut` and
`__adeukBridgeIn`, which the test joins between the two browsers.

## 6. Known limitations

- **Lockstep feel.** Every input lands D ticks (33–100 ms) late, and a lag spike on either side stalls both. There is
  no rollback (STEP0 §5 explains why).
- **The delay is fixed per match**, measured at the stage confirm. It doesn't adapt if the route changes mid-match.
- **A hidden tab stops its sim** (no requestAnimationFrame), so the other player waits. The heartbeat and pongs keep
  the link alive. After 5 minutes hidden, Chrome throttles timers to one a minute, but pongs are answered as messages
  arrive, so the link holds while the other side is in front.
- **The build id is the commit.** Vercel must expose `VERCEL_GIT_COMMIT_SHA` at build time (the default). Otherwise the
  Vercel build says `dev` and won't match a Pages build of the same commit. Players on the same site are always fine.
- **The debug-tuning check is coarse.** A tab that moved even a render-only knob must reload to play online.
- **Rate limits are per isolate and in memory:** fine against casual abuse, not a determined attacker. Cloudflare's
  Rate Limiting binding would be the upgrade.
- **Online offers the shipped roster without the Mouth**, intersected with the peer's list at the handshake. The stages
  are the app's stage roster.
- **Not tested over real WebRTC or the real worker.** Both are written against the specs and type-checked, but nothing
  could be deployed here. The first real test is two machines after WJ deploys. Safari is untested (see STEP0).
- **Bandwidth and the room socket stay open during a match.** The socket is idle (hibernation), and it's what makes the
  WebRTC reconnect possible.
