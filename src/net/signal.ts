/**
 * The client of the signalling worker (netplay-worker/, docs/netplay/STEP1.md §2).
 *
 *   POST {base}/rooms                        → { code, token }   a new room; the token proves you are its host
 *   GET  {base}/rooms/{code}/ws?role=…&token=…  WebSocket into the room (role host | guest)
 *   GET  {base}/turn?room=…&token=…          → { iceServers }    short-lived STUN/TURN credentials (room members only)
 *
 * On the socket the worker sends JSON:
 *   { t: 'joined', role, token, peer }   you are in (`token` lets you reconnect into the same seat)
 *   { t: 'peer', present }               the other player arrived or left
 *   { t: 'relay', d }                    a message from the other player (SDP offers / answers, ICE candidates)
 *   { t: 'error', code }                 notfound | full | badtoken | expired | ratelimit | badrequest
 * and accepts { t: 'relay', d } (forwarded to the other player) and the text "ping" (answered "pong").
 */

export type SignalError =
  'notfound' | 'full' | 'badtoken' | 'expired' | 'ratelimit' | 'badrequest' | 'network';

export interface SignalHandlers {
  joined(token: string, peerPresent: boolean): void;
  peer(present: boolean): void;
  relay(d: unknown): void;
  error(code: SignalError): void;
  closed(): void;
}

const FETCH_TIMEOUT_MS = 8000;

async function fetchJson(url: string, init: RequestInit = {}): Promise<{ status: number; body: unknown }> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(url, { ...init, signal: ctl.signal });
    let body: unknown = null;
    try {
      body = await r.json();
    } catch {
      body = null;
    }
    return { status: r.status, body };
  } finally {
    clearTimeout(timer);
  }
}

/** Ask the worker for a new room. Throws a SignalError string on failure. */
export async function createRoom(base: string): Promise<{ code: string; token: string }> {
  let res: { status: number; body: unknown };
  try {
    res = await fetchJson(`${base}/rooms`, { method: 'POST' });
  } catch {
    throw 'network' as SignalError;
  }
  const b = res.body as { code?: unknown; token?: unknown } | null;
  if (res.status === 429) throw 'ratelimit' as SignalError;
  if (res.status !== 200 || typeof b?.code !== 'string' || typeof b.token !== 'string')
    throw 'network' as SignalError;
  return { code: b.code, token: b.token };
}

/** STUN plus short-lived TURN credentials. Falls back to public STUN only (no relay) if the worker cannot mint them. */
export async function fetchIceServers(base: string, code: string, token: string): Promise<RTCIceServer[]> {
  const fallback: RTCIceServer[] = [{ urls: 'stun:stun.cloudflare.com:3478' }];
  try {
    const q = new URLSearchParams({ room: code, token });
    const res = await fetchJson(`${base}/turn?${q.toString()}`);
    const ice = (res.body as { iceServers?: unknown } | null)?.iceServers;
    if (res.status === 200 && Array.isArray(ice) && ice.length) return ice as RTCIceServer[];
  } catch {
    /* fall through */
  }
  return fallback;
}

/** The room socket. Reconnects are the session's job (it opens a new SignalSocket with the seat token). */
export class SignalSocket {
  private ws: WebSocket | null;
  private keepalive = 0;
  private closedByUs = false;

  constructor(base: string, code: string, role: 'host' | 'guest', token: string | null, h: SignalHandlers) {
    const q = new URLSearchParams({ role });
    if (token) q.set('token', token);
    const url = `${base.replace(/^http/i, 'ws')}/rooms/${encodeURIComponent(code)}/ws?${q.toString()}`;
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      this.ws = null;
      setTimeout(() => h.error('network'), 0);
      return;
    }
    this.ws = ws;
    let opened = false;
    ws.onopen = () => {
      opened = true;
      this.keepalive = window.setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send('ping');
      }, 20_000);
    };
    ws.onmessage = (ev: MessageEvent) => {
      if (typeof ev.data !== 'string' || ev.data === 'pong') return;
      let m: { t?: string; token?: unknown; peer?: unknown; present?: unknown; d?: unknown; code?: unknown };
      try {
        m = JSON.parse(ev.data) as typeof m;
      } catch {
        return;
      }
      if (m.t === 'joined') h.joined(String(m.token ?? ''), m.peer === true);
      else if (m.t === 'peer') h.peer(m.present === true);
      else if (m.t === 'relay') h.relay(m.d);
      else if (m.t === 'error') h.error((typeof m.code === 'string' ? m.code : 'badrequest') as SignalError);
    };
    ws.onclose = () => {
      window.clearInterval(this.keepalive);
      if (this.closedByUs) return;
      if (!opened) h.error('network');
      else h.closed();
    };
  }

  get open(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  send(d: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ t: 'relay', d }));
  }

  close(): void {
    this.closedByUs = true;
    window.clearInterval(this.keepalive);
    try {
      this.ws?.close(1000, 'bye');
    } catch {
      /* already closed */
    }
    this.ws = null;
  }
}
