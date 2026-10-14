/**
 * Minimal local type stubs for the Cloudflare Workers runtime, so this folder type-checks with no extra npm packages
 * (`npx tsc -p netplay-worker`). They cover only what src/index.ts uses.
 *
 * Nicer: install the real types (`npm i -D @cloudflare/workers-types` in the repo, or `npx wrangler types`), set
 * `"types": ["@cloudflare/workers-types"]` in netplay-worker/tsconfig.json, and delete this file.
 */

declare module 'cloudflare:workers' {
  export abstract class DurableObject<Env = unknown> {
    protected ctx: DurableObjectState;
    protected env: Env;
    constructor(ctx: DurableObjectState, env: Env);
  }
}

interface DurableObjectId {
  toString(): string;
}

interface DurableObjectStub {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
interface DurableObjectNamespace<T = unknown> {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub;
}

interface DurableObjectStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  put(entries: Record<string, unknown>): Promise<void>;
  deleteAll(): Promise<void>;
  setAlarm(scheduledTime: number | Date): Promise<void>;
}

interface DurableObjectState {
  readonly storage: DurableObjectStorage;
  acceptWebSocket(ws: WebSocket, tags?: string[]): void;
  getWebSockets(tag?: string): WebSocket[];
  setWebSocketAutoResponse(pair?: WebSocketRequestResponsePair): void;
}

declare class WebSocketPair {
  0: WebSocket;
  1: WebSocket;
}

declare class WebSocketRequestResponsePair {
  constructor(request: string, response: string);
}

interface WebSocket {
  /** Workers: accept the server end of a WebSocketPair (non-hibernating). */
  accept(): void;
  /** Hibernation API: per-socket state that survives the object hibernating (≤ 16 KiB). */
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
}

interface ResponseInit {
  /** Workers: the client end of a WebSocketPair for a 101 upgrade response. */
  webSocket?: WebSocket | null;
}
