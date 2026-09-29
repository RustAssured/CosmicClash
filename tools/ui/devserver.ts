import { createServer, type ViteDevServer } from 'vite';

/**
 * A throwaway Vite dev server for the tools and specs in this module (default port 5204, the one reserved for B4).
 *
 * File watching and HMR are OFF: with several people editing `src/` while a spec runs, Vite's watcher would push a full page
 * reload into the page under test ("Execution context was destroyed") and the spec would fail for reasons that have nothing
 * to do with the code it is checking. A spec serves the tree as it was when the server started.
 */
export async function startDevServer(port = 5204): Promise<{ server: ViteDevServer; url: string }> {
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
