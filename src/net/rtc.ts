import { isControlMsg, type ControlMsg, type LinkHandlers, type LinkState, type NetLink } from './link';

/**
 * The WebRTC link (browser-native RTCPeerConnection, no dependencies). Two pre-negotiated DataChannels:
 *  - id 0 'ctl': ordered, reliable (handshake, picks, start, rematch, goodbye);
 *  - id 1 'in' : unordered, no retransmits (lockstep input packets and pings; every packet repeats what the peer has not
 *    acknowledged, so a lost one is simply covered by the next, and no packet ever waits for an older one).
 * Pre-negotiated channels (`negotiated: true`) exist on both sides from the start: no `ondatachannel` race.
 *
 * Signalling messages (`RtcSignal`) travel through the worker's room socket. `gen` numbers each connection attempt, so a
 * reconnect (a fresh RTCPeerConnection after the old one failed) ignores stragglers from the previous one.
 */
export type RtcSignal =
  | { k: 'offer'; gen: number; sdp: string }
  | { k: 'answer'; gen: number; sdp: string }
  | { k: 'ice'; gen: number; c: RTCIceCandidateInit };

export function isRtcSignal(v: unknown): v is RtcSignal {
  const o = v as { k?: unknown; gen?: unknown } | null;
  return (
    typeof o === 'object' &&
    o !== null &&
    (o.k === 'offer' || o.k === 'answer' || o.k === 'ice') &&
    typeof o.gen === 'number'
  );
}

export interface RtcLink extends NetLink {
  readonly gen: number;
  handleSignal(s: RtcSignal): void;
}

const MAX_FAST_BUFFER = 64 * 1024;

export function createRtcLink(
  opts: { offerer: boolean; gen: number; iceServers: RTCIceServer[]; signal: (s: RtcSignal) => void },
  h: LinkHandlers,
): RtcLink {
  const pc = new RTCPeerConnection({ iceServers: opts.iceServers });
  const ctl = pc.createDataChannel('ctl', { negotiated: true, id: 0, ordered: true });
  const fast = pc.createDataChannel('in', { negotiated: true, id: 1, ordered: false, maxRetransmits: 0 });
  ctl.binaryType = 'arraybuffer';
  fast.binaryType = 'arraybuffer';
  let state: LinkState = 'connecting';
  let remoteSet = false;
  const pendingIce: RTCIceCandidateInit[] = [];
  const gen = opts.gen;

  const setState = (s: LinkState): void => {
    if (state === s || state === 'closed') return;
    state = s;
    h.state(s);
  };
  const channelsOpen = (): boolean => ctl.readyState === 'open' && fast.readyState === 'open';
  const maybeOpen = (): void => {
    if (channelsOpen() && pc.connectionState !== 'disconnected') setState('open');
  };
  ctl.onopen = maybeOpen;
  fast.onopen = maybeOpen;
  ctl.onclose = () => setState('closed');
  fast.onclose = () => setState('closed');
  ctl.onmessage = (ev: MessageEvent) => {
    if (typeof ev.data !== 'string') return;
    try {
      const m = JSON.parse(ev.data) as unknown;
      if (isControlMsg(m)) h.control(m);
    } catch {
      /* not ours */
    }
  };
  fast.onmessage = (ev: MessageEvent) => {
    if (ev.data instanceof ArrayBuffer) h.fast(new Uint8Array(ev.data));
  };
  pc.onicecandidate = (ev) => {
    if (ev.candidate) opts.signal({ k: 'ice', gen, c: ev.candidate.toJSON() });
  };
  pc.onconnectionstatechange = () => {
    const s = pc.connectionState;
    if (s === 'connected') maybeOpen();
    else if (s === 'disconnected') {
      if (state === 'open') setState('interrupted');
    } else if (s === 'failed' || s === 'closed') setState('closed');
  };

  const flushIce = async (): Promise<void> => {
    for (const c of pendingIce.splice(0)) {
      try {
        await pc.addIceCandidate(c);
      } catch {
        /* a stale candidate */
      }
    }
  };

  if (opts.offerer) {
    void (async () => {
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        opts.signal({ k: 'offer', gen, sdp: pc.localDescription?.sdp ?? offer.sdp ?? '' });
      } catch {
        setState('closed');
      }
    })();
  }

  return {
    gen,
    get state() {
      return state;
    },
    sendFast(bytes) {
      if (fast.readyState !== 'open' || fast.bufferedAmount > MAX_FAST_BUFFER) return;
      try {
        fast.send(bytes as Uint8Array<ArrayBuffer>);
      } catch {
        /* closing */
      }
    },
    sendControl(msg: ControlMsg) {
      if (ctl.readyState !== 'open') return;
      try {
        ctl.send(JSON.stringify(msg));
      } catch {
        /* closing */
      }
    },
    handleSignal(s) {
      if (s.gen !== gen || state === 'closed') return;
      if (s.k === 'ice') {
        if (!remoteSet) pendingIce.push(s.c);
        else pc.addIceCandidate(s.c).catch(() => undefined);
        return;
      }
      void (async () => {
        try {
          if (s.k === 'offer' && !opts.offerer) {
            await pc.setRemoteDescription({ type: 'offer', sdp: s.sdp });
            remoteSet = true;
            await flushIce();
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            opts.signal({ k: 'answer', gen, sdp: pc.localDescription?.sdp ?? answer.sdp ?? '' });
          } else if (s.k === 'answer' && opts.offerer && !remoteSet) {
            await pc.setRemoteDescription({ type: 'answer', sdp: s.sdp });
            remoteSet = true;
            await flushIce();
          }
        } catch {
          setState('closed');
        }
      })();
    },
    close() {
      state = 'closed';
      try {
        ctl.close();
        fast.close();
        pc.close();
      } catch {
        /* already closed */
      }
    },
  };
}
