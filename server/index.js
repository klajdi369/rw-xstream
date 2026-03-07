import http from 'node:http';
import { send } from './utils.js';
import { handleProxy, handleProxyTranscode } from './handlers/proxy.js';
import { handleRemuxStart, serveRemuxAsset, handleRemuxDebug } from './handlers/remux.js';
import { serveStatic } from './handlers/static.js';

const PORT = Number(process.env.PORT || 3004);
const HOST = '0.0.0.0';
const API_ONLY = process.env.API_ONLY === '1';

const server = http.createServer(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    send(res, 405, 'text/plain; charset=utf-8', 'Method Not Allowed');
    return;
  }

  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  if (url.pathname === '/proxy') {
    await handleProxy(req, res, url, PORT);
    return;
  }

  if (url.pathname === '/proxy-transcode') {
    await handleProxyTranscode(res, url);
    return;
  }

  if (url.pathname === '/remux/start') {
    await handleRemuxStart(res, url);
    return;
  }

  if (url.pathname.startsWith('/remux/hls/')) {
    serveRemuxAsset(url.pathname, res);
    return;
  }

  if (url.pathname === '/remux/debug') {
    handleRemuxDebug(res);
    return;
  }

  if (API_ONLY) {
    send(res, 404, 'text/plain; charset=utf-8', 'Not Found');
    return;
  }

  serveStatic(url.pathname, res);
});

server.listen(PORT, HOST, () => {
  console.log(`IPTV app server listening on http://${HOST}:${PORT}`);
});
