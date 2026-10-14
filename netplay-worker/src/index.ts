/**
 * ADEUK: TITANS netplay signalling worker (docs/netplay/STEP1.md §2; deploy: netplay-worker/README.md).
 *
 * It only introduces two players and hands out short-lived TURN credentials; the match itself runs peer to peer over
 * WebRTC and never touches this worker.
 *
 *   POST /rooms                          → { code, token }  a new room (6 characters, no look-alikes) and the host's seat token
 *   GET  /rooms/:code/ws?role=…&token=…  WebSocket into the room's Durable Object (role host | guest); relays SDP and ICE
 *   GET  /turn?room=…&token=…            → { iceServers }   STUN + TURN credentials minted for 3 hours, for room members only
 *   GET  /                               → "ok"
 *
 * Nothing persists beyond a room: each room's Durable Object deletes all its storage when the room expires (unjoined for
 * 15 minutes, empty for 2 minutes, or 3 hours old). Basic abuse limits: allowed origins only, per-IP request rates, and
 * per-socket message rate / size caps. Secrets (TURN_KEY_ID, TURN_KEY_API_TOKEN) live in Worker secrets, never in the repo.
 */
import { DurableObject } from 'cloudflare:workers';

export interface Env {
  ROOMS: DurableObjectNamespace<Room>;
  /** Comma-separated origins allowed to call the worker (wrangler.toml [vars]); localhost / 127.0.0.1 on any port always. */
  ALLOWED_ORIGINS?: string;
  /** Worker secrets (`npx wrangler secret put …`): the Cloudflare Realtime TURN key. */
  TURN_KEY_ID?: string;
  TURN_KEY_API_TOKEN?: string;
}

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LEN = 6;
const TURN_TTL_SEC = 3 * 60 * 60;
const ROOM_MAX_MS = 3 * 60 * 60 * 1000;
const UNJOINED_MS = 15 * 60 * 1000;
const EMPTY_GRACE_MS = 2 * 60 * 1000;
const CHECK_MS = 5 * 60 * 1000;
const MAX_MSG_BYTES = 16 * 1024;
const MSG_WINDOW_MS = 10_000;
const MSG_PER_WINDOW = 120;
const WS_OPEN = 1;

/* ------------------------------------------------------------------------------------------------ *
 *  helpers
 * ------------------------------------------------------------------------------------------------ */
function randomString(n: number, alphabet: string): string {
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  let s = '';
  // 248 = the largest multiple of 31 below 256: no modulo bias
  for (let i = 0; i < n; i++) {
    let b = bytes[i]!;
    while (b >= 248) {
      const r = new Uint8Array(1);
      crypto.getRandomValues(r);
      b = r[0]!;
    }
    s += alphabet[b % alphabet.length];
  }
  return s;
}

const newToken = (): string => randomString(24, 'abcdefghijkmnpqrstuvwxyz23456789');
const isCode = (s: string): boolean => s.length === CODE_LEN && [...s].every((c) => ALPHABET.includes(c));

function originAllowed(origin: string | null, env: Env): boolean {
  if (!origin) return true; // not a browser page (curl, health checks): no CORS to grant anyway
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return false;
  }
  if (u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]') return true;
  const list = (env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  return list.includes(origin.replace(/\/+$/, ''));
}

function cors(origin: string | null): Record<string, string> {
  return origin
    ? {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '86400',
        Vary: 'Origin',
      }
    : {};
}

function json(body: unknown, status: number, origin: string | null): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors(origin) },
  });
}

/** Per-IP request limits, per isolate (best effort: Cloudflare runs many isolates; a determined abuser gets further). */
const hits = new Map<string, { n: number; reset: number }>();
function limited(ip: string, bucket: string, max: number, windowMs = 60_000): boolean {
  const now = Date.now();
  if (hits.size > 10_000) for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
  const key = `${bucket}:${ip}`;
  const e = hits.get(key);
  if (!e || e.reset < now) {
    hits.set(key, { n: 1, reset: now + windowMs });
    return false;
  }
  e.n++;
  return e.n > max;
}

/** Mint TURN credentials from Cloudflare Realtime (TURN service). Port 53 URLs are dropped: browsers block that port. */
async function mintIceServers(env: Env): Promise<unknown[] | null> {
  if (!env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN) return null;
  const r = await fetch(
    `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(env.TURN_KEY_ID)}/credentials/generate-ice-servers`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl: TURN_TTL_SEC }),
    },
  );
  if (!r.ok) return null;
  const body = (await r.json()) as { iceServers?: unknown };
  const list = Array.isArray(body.iceServers) ? body.iceServers : body.iceServers ? [body.iceServers] : [];
  return list.map((s) => {
    const srv = s as { urls?: string | string[] };
    const urls = (Array.isArray(srv.urls) ? srv.urls : srv.urls ? [srv.urls] : []).filter(
      (u) => !/:53(\?|$)/.test(u),
    );
    return { ...srv, urls };
  });
}

/* ------------------------------------------------------------------------------------------------ *
 *  the worker
 * ------------------------------------------------------------------------------------------------ */
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const origin = req.headers.get('Origin');
    if (!originAllowed(origin, env)) return new Response('origin not allowed', { status: 403 });
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) });
    const ip = req.headers.get('CF-Connecting-IP') ?? 'unknown';
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (path === '/') return new Response('ok', { headers: cors(origin) });

    if (path === '/rooms' && req.method === 'POST') {
      if (limited(ip, 'create', 10)) return json({ error: 'ratelimit' }, 429, origin);
      for (let i = 0; i < 6; i++) {
        const code = randomString(CODE_LEN, ALPHABET);
        const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
        const r = await stub.fetch('https://room/init', { method: 'POST' });
        if (r.status === 200) {
          const { token } = (await r.json()) as { token: string };
          return json({ code, token }, 200, origin);
        }
      }
      return json({ error: 'busy' }, 503, origin);
    }

    const ws = /^\/rooms\/([A-Za-z0-9]+)\/ws$/.exec(path);
    if (ws && req.method === 'GET') {
      if (req.headers.get('Upgrade')?.toLowerCase() !== 'websocket')
        return new Response('expected a WebSocket', { status: 426 });
      if (limited(ip, 'ws', 30)) return new Response('rate limited', { status: 429 });
      const code = ws[1]!.toUpperCase();
      if (!isCode(code)) return new Response('bad room code', { status: 400 });
      return env.ROOMS.get(env.ROOMS.idFromName(code)).fetch(req);
    }

    if (path === '/turn' && req.method === 'GET') {
      if (limited(ip, 'turn', 20)) return json({ error: 'ratelimit' }, 429, origin);
      const code = (url.searchParams.get('room') ?? '').toUpperCase();
      const token = url.searchParams.get('token') ?? '';
      if (!isCode(code) || !token) return json({ error: 'badrequest' }, 400, origin);
      // only members of a live room get relay credentials
      const check = await env.ROOMS.get(env.ROOMS.idFromName(code)).fetch(
        `https://room/check?token=${encodeURIComponent(token)}`,
      );
      if (check.status !== 200) return json({ error: 'badtoken' }, 403, origin);
      const ice = await mintIceServers(env);
      return json({ iceServers: ice ?? [{ urls: 'stun:stun.cloudflare.com:3478' }] }, 200, origin);
    }

    return new Response('not found', { status: 404, headers: cors(origin) });
  },
};

/* ------------------------------------------------------------------------------------------------ *
 *  the room (one Durable Object per code)
 * ------------------------------------------------------------------------------------------------ */
type Role = 'host' | 'guest';
interface SocketMeta {
  role: Role;
  windowStart: number;
  count: number;
}

export class Room extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // keepalive pings are answered without waking the object
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  private sockets(role?: Role, except?: WebSocket): WebSocket[] {
    return this.ctx.getWebSockets(role).filter((s) => s !== except && s.readyState === WS_OPEN);
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const st = this.ctx.storage;

    if (url.pathname === '/init') {
      if (await st.get<number>('created')) return new Response('taken', { status: 409 });
      const token = newToken();
      await st.put({ created: Date.now(), hostToken: token });
      await st.setAlarm(Date.now() + UNJOINED_MS);
      return new Response(JSON.stringify({ token }), { status: 200 });
    }

    if (url.pathname === '/check') {
      const t = url.searchParams.get('token');
      const [host, guest] = [await st.get<string>('hostToken'), await st.get<string>('guestToken')];
      return new Response(null, { status: t && (t === host || t === guest) ? 200 : 403 });
    }

    // the room socket
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const refuse = (code: string): Response => {
      server.accept();
      server.send(JSON.stringify({ t: 'error', code }));
      server.close(4000, code);
      return new Response(null, { status: 101, webSocket: client });
    };
    const created = await st.get<number>('created');
    if (!created) return refuse('notfound');
    if (Date.now() - created > ROOM_MAX_MS) return refuse('expired');
    const role = url.searchParams.get('role');
    const token = url.searchParams.get('token');
    if (role !== 'host' && role !== 'guest') return refuse('badrequest');
    let seat: string;
    if (role === 'host') {
      if (token !== (await st.get<string>('hostToken'))) return refuse('badtoken');
      seat = token;
    } else {
      const guest = await st.get<string>('guestToken');
      if (!guest) {
        seat = newToken();
        await st.put('guestToken', seat);
      } else if (token === guest) seat = guest;
      else return refuse('full');
    }
    // a reconnect replaces the seat's old socket
    for (const old of this.sockets(role)) old.close(4001, 'replaced');
    this.ctx.acceptWebSocket(server, [role]);
    server.serializeAttachment({ role, windowStart: Date.now(), count: 0 } satisfies SocketMeta);
    const other: Role = role === 'host' ? 'guest' : 'host';
    const peers = this.sockets(other);
    server.send(JSON.stringify({ t: 'joined', role, token: seat, peer: peers.length > 0 }));
    for (const p of peers) p.send(JSON.stringify({ t: 'peer', present: true }));
    await st.setAlarm(Date.now() + CHECK_MS);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const meta = ws.deserializeAttachment() as SocketMeta;
    const now = Date.now();
    if (now - meta.windowStart > MSG_WINDOW_MS) {
      meta.windowStart = now;
      meta.count = 0;
    }
    meta.count++;
    ws.serializeAttachment(meta);
    if (meta.count > MSG_PER_WINDOW) {
      ws.send(JSON.stringify({ t: 'error', code: 'ratelimit' }));
      ws.close(4008, 'ratelimit');
      return;
    }
    if (typeof message !== 'string' || message.length > MAX_MSG_BYTES) {
      ws.close(4009, 'too big');
      return;
    }
    let m: { t?: unknown; d?: unknown };
    try {
      m = JSON.parse(message) as typeof m;
    } catch {
      return;
    }
    if (m.t !== 'relay') return;
    const other: Role = meta.role === 'host' ? 'guest' : 'host';
    const out = JSON.stringify({ t: 'relay', d: m.d });
    for (const p of this.sockets(other)) p.send(out);
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    await this.gone(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.gone(ws);
  }

  private async gone(ws: WebSocket): Promise<void> {
    const meta = ws.deserializeAttachment() as SocketMeta | null;
    if (meta) {
      const other: Role = meta.role === 'host' ? 'guest' : 'host';
      // only "left" if that seat has no other (reconnected) socket
      if (this.sockets(meta.role, ws).length === 0)
        for (const p of this.sockets(other, ws)) p.send(JSON.stringify({ t: 'peer', present: false }));
    }
    if (this.sockets(undefined, ws).length === 0)
      await this.ctx.storage.setAlarm(Date.now() + EMPTY_GRACE_MS);
  }

  async alarm(): Promise<void> {
    const st = this.ctx.storage;
    const created = await st.get<number>('created');
    if (!created) return;
    const now = Date.now();
    const open = this.sockets();
    const unjoined = !(await st.get<string>('guestToken')) && now - created > UNJOINED_MS;
    if (now - created > ROOM_MAX_MS || open.length === 0 || unjoined) {
      for (const s of open) {
        s.send(JSON.stringify({ t: 'error', code: 'expired' }));
        s.close(4002, 'expired');
      }
      await st.deleteAll();
      return;
    }
    await st.setAlarm(now + CHECK_MS);
  }
}
