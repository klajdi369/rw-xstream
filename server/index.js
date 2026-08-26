import http from 'node:http';
import { send } from './utils.js';
import { handleProxy, handleProxyTranscode } from './handlers/proxy.js';
import { handleEpg } from './handlers/epg.js';
import { serveStatic } from './handlers/static.js';

// Default off Vite's dev port (3004) so a bare `node server/index.js` never
// collides with the dev server; the dev script sets PORT explicitly anyway.
const PORT = Number(process.env.PORT || 8080);
const HOST = '0.0.0.0';
const API_ONLY = process.env.API_ONLY === '1';

async function route(req, res, url) {
  if (url.pathname === '/proxy') {
    await handleProxy(req, res, url, PORT);
    return;
  }

  if (url.pathname === '/proxy-transcode') {
    await handleProxyTranscode(res, url);
    return;
  }

  if (url.pathname === '/epg') {
    await handleEpg(res, url);
    return;
  }

  if (API_ONLY) {
    send(res, 404, 'text/plain; charset=utf-8', 'Not Found');
    return;
  }

  serveStatic(url.pathname, res);
}

const server = http.createServer(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    send(res, 405, 'text/plain; charset=utf-8', 'Method Not Allowed');
    return;
  }

  let url;
  try {
    url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  } catch {
    send(res, 400, 'text/plain; charset=utf-8', 'Bad Request');
    return;
  }

  try {
    await route(req, res, url);
  } catch (err) {
    console.error(`[SERVER] unhandled error for ${req.method} ${url.pathname}:`, err);
    // A handler threw after already streaming; send() no-ops if headers are out.
    send(res, 500, 'text/plain; charset=utf-8', 'Internal Server Error');
  }
});

// A rejected promise or a stray throw in a background callback must not take
// the whole server down and kill every viewer.
process.on('unhandledRejection', (reason) => {
  console.error('[SERVER] unhandledRejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[SERVER] uncaughtException:', err);
});

server.listen(PORT, HOST, () => {
  console.log(`IPTV app server listening on http://${HOST}:${PORT}`);
});
