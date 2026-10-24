import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import type { Plugin } from 'vite';

/**
 * THE TITAN BUILDER'S FILE BRIDGE (dev server only): the builder page (dev/builder/) runs in the browser and cannot write
 * files, so `npm run dev` serves a few endpoints under /__builder/ that read and save a kit titan's JSON and run the kit's
 * own commands (`new:titan`, `titan:check`). The JSON stays the one source of truth; the CLI keeps working beside it.
 *
 *   GET  /__builder/titans          every kit titan: [{ id, name, template, kind, wip }]
 *   GET  /__builder/titan?id=<id>   its JSON, as saved
 *   PUT  /__builder/titan?id=<id>   save its JSON (validated as JSON, same id, has a kit block; prettier-formatted)
 *   POST /__builder/new             { id, name, ko, kind, size, from?, hue? } → `npm run new:titan` (output returned)
 *   POST /__builder/check?id=<id>   `npm run titan:check -- <id> --quick` (output returned)
 *   GET  /__builder/body?id=<id>    an imported titan's body.json (null if it has none)
 *   PUT  /__builder/body?id=<id>    { def, body, keyart? }: make it an imported-art titan (src/titans/kit/image.ts): writes
 *                                   body.json, its JSON and its index.ts (the image painter); the key art (a data URL) goes
 *                                   to docs/titans/<id>/keyart.<ext>. Only for blob-template or already-imported titans.
 *   GET  /__builder/brief?id=<id>   docs/titans/<id>/BRIEF.md ('' if none)
 *   PUT  /__builder/brief?id=<id>   { text }: write it
 *
 * The dev server listens on the LAN (vite.config.ts `host`), so the bridge only answers the machine itself (loopback), and
 * anything that writes needs the `x-titan-builder` header (a page on another origin cannot send it without a preflight,
 * which the bridge never grants). Commands run with argument arrays, never through a shell.
 */

const ROOT = process.cwd();
const KIT_DIR = join(ROOT, 'src/titans/kit');
const ID_RE = /^[a-z][a-z0-9]{2,15}$/;
// kept here, not imported: anything vite.config.ts imports is a config dependency, and the scaffold edits the roster
// contract, which would restart the dev server in the middle of the request (plugin.test.ts keeps these in step)
export const KINDS: readonly string[] = ['celestial', 'mineral', 'organic', 'construct', 'cosmic'];
export const SIZES: readonly string[] = ['small', 'medium', 'large', 'huge'];
const TEMPLATES = ['blob', 'planet', 'asteroid', 'nexus', 'blackhole', 'supernova', 'lastone'];
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

const jsonPath = (id: string): string => join(KIT_DIR, id, `${id}.json`);
const docsDir = (id: string): string => join(ROOT, 'docs/titans', id);

/** The index.ts of a titan whose body is imported art (the image painter reading its body.json). */
const imageIndexTs = (id: string): string => `import type { TitanDef } from '@/contracts';
import { buildImageRig, paintImage, type ImageBody } from '../image';
import type { KitTitan } from '../types';
import body from './body.json';
import json from './${id}.json';

/**
 * ${id}: a kit titan whose body was imported from key art in the titan builder (dev/builder/, "Import art"): body.json holds
 * its cells, the image painter (src/titans/kit/image.ts) lights them with its JSON's material ramps. Re-import or recolour it
 * in the builder; write its own painter here if it outgrows the import.
 */
const def = json as unknown as TitanDef;
const art = body as ImageBody;
const kit: KitTitan = { def, paint: (d, _seed, light) => paintImage(d, art, light), rig: (d) => buildImageRig(d, art) };
export default kit;
`;

function send(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage, limit = 4 << 20): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** Run a TypeScript tool with this Node and tsx (no shell): its exit code and combined output. */
function runTool(script: string, args: string[]): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ['--import', 'tsx', script, ...args], {
      cwd: ROOT,
      env: { ...process.env, FORCE_COLOR: '0' },
    });
    let output = '';
    p.stdout.on('data', (d: Buffer) => (output += d.toString()));
    p.stderr.on('data', (d: Buffer) => (output += d.toString()));
    p.on('close', (code) => resolve({ code: code ?? 1, output }));
    p.on('error', (e) => resolve({ code: 1, output: String(e) }));
  });
}

function listTitans(): unknown[] {
  return readdirSync(KIT_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && ID_RE.test(d.name) && existsSync(jsonPath(d.name)))
    .map((d) => {
      const def = JSON.parse(readFileSync(jsonPath(d.name), 'utf8')) as {
        name: string;
        kit?: { template?: string; kind?: string; wip?: boolean };
      };
      return {
        id: d.name,
        name: def.name,
        template: def.kit?.template ?? 'blob',
        kind: def.kit?.kind ?? null,
        wip: !!def.kit?.wip,
      };
    });
}

async function formatJson(text: string, file: string): Promise<string> {
  const prettier = await import('prettier');
  const options = (await prettier.resolveConfig(file)) ?? {};
  return prettier.format(text, { ...options, filepath: file });
}

/** A short single-line text field (names), or null. */
const text = (v: unknown, max = 40): string | null =>
  typeof v === 'string' && v.trim().length > 0 && v.length <= max && !/[\p{Cc}"`\\]/u.test(v)
    ? v.trim()
    : null;

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  q: URLSearchParams,
): Promise<void> {
  const write = req.method !== 'GET';
  if (write && req.headers['x-titan-builder'] !== '1')
    return send(res, 403, { error: 'missing builder header' });

  if (path === 'titans' && req.method === 'GET') return send(res, 200, listTitans());

  if (path === 'titan') {
    const id = q.get('id') ?? '';
    if (!ID_RE.test(id) || !existsSync(jsonPath(id)))
      return send(res, 404, { error: `no kit titan '${id}'` });
    if (req.method === 'GET') return send(res, 200, JSON.parse(readFileSync(jsonPath(id), 'utf8')));
    if (req.method === 'PUT') {
      let def: { id?: unknown; kit?: unknown };
      try {
        def = JSON.parse(await readBody(req)) as typeof def;
      } catch {
        return send(res, 400, { error: 'not JSON' });
      }
      if (def.id !== id) return send(res, 400, { error: `the definition's id is not '${id}'` });
      if (!def.kit || typeof def.kit !== 'object') return send(res, 400, { error: 'no kit block' });
      const file = jsonPath(id);
      writeFileSync(file, await formatJson(JSON.stringify(def, null, 2) + '\n', file));
      return send(res, 200, { saved: `src/titans/kit/${id}/${id}.json` });
    }
  }

  if (path === 'new' && req.method === 'POST') {
    let b: Record<string, unknown>;
    try {
      b = JSON.parse(await readBody(req, 4096)) as Record<string, unknown>;
    } catch {
      return send(res, 400, { error: 'not JSON' });
    }
    const id = typeof b['id'] === 'string' ? b['id'] : '';
    const name = text(b['name']);
    const ko = text(b['ko'], 20);
    const kind = String(b['kind'] ?? '');
    const size = String(b['size'] ?? 'medium');
    const from = String(b['from'] ?? 'blob');
    if (!ID_RE.test(id))
      return send(res, 400, { error: 'id: 3–16 lowercase letters/digits, starting with a letter' });
    if (!name || !ko) return send(res, 400, { error: 'an English and a Korean name are needed' });
    if (!KINDS.includes(kind)) return send(res, 400, { error: `kind: one of ${KINDS.join(', ')}` });
    if (!SIZES.includes(size)) return send(res, 400, { error: `size: one of ${SIZES.join(', ')}` });
    if (!TEMPLATES.includes(from))
      return send(res, 400, { error: `template: one of ${TEMPLATES.join(', ')}` });
    const args = [id, name, ko, `--kind=${kind}`, `--size=${size}`, `--from=${from}`];
    if (b['hue'] != null && b['hue'] !== '') {
      const hue = Math.round(Number(b['hue']));
      if (!(hue >= 0 && hue < 360)) return send(res, 400, { error: 'hue: 0–359' });
      args.push(`--hue=${hue}`);
    }
    const r = await runTool('tools/titans/new.ts', args);
    return send(res, r.code === 0 ? 200 : 500, { ok: r.code === 0, output: r.output });
  }

  if (path === 'body' || path === 'brief') {
    const id = q.get('id') ?? '';
    if (!ID_RE.test(id) || !existsSync(jsonPath(id)))
      return send(res, 404, { error: `no kit titan '${id}'` });
    const dir = join(KIT_DIR, id);
    if (path === 'brief') {
      const file = join(docsDir(id), 'BRIEF.md');
      if (req.method === 'GET')
        return send(res, 200, { text: existsSync(file) ? readFileSync(file, 'utf8') : '' });
      if (req.method === 'PUT') {
        const b = JSON.parse(await readBody(req, 512 << 10)) as { text?: unknown };
        if (typeof b.text !== 'string') return send(res, 400, { error: 'no text' });
        mkdirSync(docsDir(id), { recursive: true });
        writeFileSync(file, b.text.endsWith('\n') ? b.text : b.text + '\n');
        return send(res, 200, { saved: `docs/titans/${id}/BRIEF.md` });
      }
    }
    if (req.method === 'GET') {
      const file = join(dir, 'body.json');
      return send(res, 200, existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null);
    }
    if (req.method === 'PUT') {
      const index = readFileSync(join(dir, 'index.ts'), 'utf8');
      if (!index.includes("from '../blob'") && !index.includes("from '../image'"))
        return send(res, 400, {
          error: `'${id}' has its own painter: art import is for blob-template titans`,
        });
      let b: { def?: { id?: unknown; kit?: unknown }; body?: Record<string, unknown>; keyart?: unknown };
      try {
        b = JSON.parse(await readBody(req, 32 << 20)) as typeof b;
      } catch {
        return send(res, 400, { error: 'not JSON' });
      }
      const body = b.body;
      const ok =
        body &&
        body['version'] === 1 &&
        Number.isInteger(body['w']) &&
        Number.isInteger(body['h']) &&
        (body['w'] as number) <= 300 &&
        (body['h'] as number) <= 300 &&
        typeof body['cells'] === 'string' &&
        /^[A-Za-z0-9+/=]*$/.test(body['cells']) &&
        typeof body['core'] === 'object';
      if (!ok) return send(res, 400, { error: 'not an image body' });
      if (b.def?.id !== id || !b.def.kit)
        return send(res, 400, { error: `the definition's id is not '${id}'` });
      const saved = [
        `src/titans/kit/${id}/body.json`,
        `src/titans/kit/${id}/${id}.json`,
        `src/titans/kit/${id}/index.ts`,
      ];
      if (typeof b.keyart === 'string') {
        const m = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(b.keyart);
        if (!m) return send(res, 400, { error: 'the key art is not a png, jpeg or webp data URL' });
        mkdirSync(docsDir(id), { recursive: true });
        const ext = m[1] === 'jpeg' ? 'jpg' : m[1]!;
        writeFileSync(join(docsDir(id), `keyart.${ext}`), Buffer.from(m[2]!, 'base64'));
        saved.push(`docs/titans/${id}/keyart.${ext}`);
      }
      // body first: the index imports it (Vite reloads the moment the index changes)
      const bodyFile = join(dir, 'body.json');
      writeFileSync(bodyFile, await formatJson(JSON.stringify(body) + '\n', bodyFile));
      writeFileSync(jsonPath(id), await formatJson(JSON.stringify(b.def, null, 2) + '\n', jsonPath(id)));
      const prettier = await import('prettier');
      const tsFile = join(dir, 'index.ts');
      const tsOptions = (await prettier.resolveConfig(tsFile)) ?? {};
      writeFileSync(tsFile, await prettier.format(imageIndexTs(id), { ...tsOptions, filepath: tsFile }));
      return send(res, 200, { saved });
    }
  }

  if (path === 'check' && req.method === 'POST') {
    const id = q.get('id') ?? '';
    if (!ID_RE.test(id) || !existsSync(jsonPath(id)))
      return send(res, 404, { error: `no kit titan '${id}'` });
    const r = await runTool('tools/titans/check.ts', [id, '--quick']);
    return send(res, 200, { ok: r.code === 0, output: r.output });
  }

  return send(res, 404, { error: 'unknown builder endpoint' });
}

export function titanBuilder(): Plugin {
  return {
    name: 'adeuk-titan-builder',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__builder', (req, res) => {
        if (!LOOPBACK.has(req.socket.remoteAddress ?? ''))
          return send(res, 403, { error: 'the titan builder only answers this machine' });
        const url = new URL(req.url ?? '/', 'http://localhost');
        handle(req, res, url.pathname.replace(/^\/+/, ''), url.searchParams).catch((e: unknown) =>
          send(res, 500, { error: String(e) }),
        );
      });
    },
  };
}
