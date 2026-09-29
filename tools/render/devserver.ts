import { createServer, type ViteDevServer } from 'vite';

/**
 * A throwaway Vite dev server for the render specs (default port 5201, the one reserved for the renderer).
 *
 * File watching and HMR are OFF: with several people editing `src/` while a spec runs, Vite's watcher would push a full page
 * reload into the page under test and the spec would fail for reasons that have nothing to do with the code it checks. A spec
 * serves the tree as it was when the server started.
 */
export async function startRenderServer(port = 5201): Promise<{ server: ViteDevServer; url: string }> {
  const server = await createServer({
    server: { port, strictPort: false, host: '127.0.0.1', hmr: false, watch: null },
    logLevel: 'error',
    clearScreen: false,
  });
  await server.listen();
  const addr = server.httpServer?.address();
  const p = typeof addr === 'object' && addr ? addr.port : port;
  return { server, url: `http://127.0.0.1:${p}` };
}
