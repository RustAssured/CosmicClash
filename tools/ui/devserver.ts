import { createServer, type ViteDevServer } from 'vite';

/** A throwaway Vite dev server for the tools and specs in this module (default port 5204, the one reserved for B4). */
export async function startDevServer(port = 5204): Promise<{ server: ViteDevServer; url: string }> {
  const server = await createServer({
    server: { port, strictPort: false, host: '127.0.0.1' },
    logLevel: 'error',
    clearScreen: false,
  });
  await server.listen();
  const addr = server.httpServer?.address();
  const p = typeof addr === 'object' && addr ? addr.port : port;
  return { server, url: `http://127.0.0.1:${p}` };
}
