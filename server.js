import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { spawn } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = 3004;
const HOST = '0.0.0.0';
const DIST_DIR = path.join(__dirname, 'dist');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function send(res, status, type, body) {
  res.writeHead(status, { 'Content-Type': type });
  res.end(body);
}

function passthroughHeaders(headers) {
  const out = {};
  const allowed = ['accept', 'user-agent', 'cache-control', 'pragma', 'range'];
  for (const key of allowed) {
    if (headers[key]) out[key] = headers[key];
  }
  return out;
}

function rewritePlaylist(body, sourceUrl, host) {
  const base = new URL(sourceUrl);
  return body
    .split('\n')
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return line;

      try {
        const absolute = new URL(trimmed, base).toString();
        return `/proxy?url=${encodeURIComponent(absolute)}&deint=1&host=${encodeURIComponent(host)}`;
      } catch {
        return line;
      }
    })
    .join('\n');
}

function proxyViaFfmpeg(stream, res) {
  const ffmpeg = spawn('ffmpeg', [
    '-hide_banner',
    '-loglevel', 'error',
    '-fflags', 'nobuffer',
    '-flags', 'low_delay',
    '-i', 'pipe:0',
    '-vf', 'yadif=0:-1:0',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-tune', 'zerolatency',
    '-pix_fmt', 'yuv420p',
    '-g', '50',
    '-keyint_min', '25',
    '-sc_threshold', '0',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-ar', '48000',
    '-ac', '2',
    '-f', 'mpegts',
    'pipe:1',
  ]);

  res.writeHead(200, {
    'Content-Type': 'video/mp2t',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'Access-Control-Allow-Origin': '*',
  });

  stream.pipe(ffmpeg.stdin);
  ffmpeg.stdout.pipe(res);

  const cleanup = () => {
    ffmpeg.kill('SIGKILL');
  };

  ffmpeg.on('error', () => {
    if (!res.headersSent) send(res, 500, 'text/plain; charset=utf-8', 'ffmpeg unavailable');
    cleanup();
  });

  ffmpeg.on('close', (code) => {
    if (code !== 0 && !res.writableEnded) {
      res.end();
    }
  });

  res.on('close', cleanup);
}

async function handleProxy(req, res, url) {
  const target = url.searchParams.get('url');
  const deint = url.searchParams.get('deint') !== '0';
  const host = url.searchParams.get('host') || `${req.headers.host ?? `127.0.0.1:${PORT}`}`;

  if (!target) return send(res, 400, 'text/plain; charset=utf-8', 'Missing url');

  let targetUrl;
  try {
    targetUrl = new URL(target);
  } catch {
    return send(res, 400, 'text/plain; charset=utf-8', 'Invalid url');
  }

  if (!['http:', 'https:'].includes(targetUrl.protocol)) {
    return send(res, 400, 'text/plain; charset=utf-8', 'Unsupported protocol');
  }

  try {
    const upstream = await fetch(targetUrl, {
      method: 'GET',
      headers: passthroughHeaders(req.headers),
      redirect: 'follow',
    });

    if (!upstream.ok) {
      return send(res, upstream.status, 'text/plain; charset=utf-8', `Upstream HTTP ${upstream.status}`);
    }

    const ctype = upstream.headers.get('content-type') || '';
    const isPlaylist = ctype.includes('mpegurl') || targetUrl.pathname.endsWith('.m3u8');
    const isTs = ctype.includes('video/mp2t') || targetUrl.pathname.endsWith('.ts');

    if (isPlaylist) {
      const text = await upstream.text();
      const rewritten = rewritePlaylist(text, targetUrl.toString(), host);
      res.writeHead(200, {
        'Content-Type': 'application/x-mpegURL',
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'Access-Control-Allow-Origin': '*',
      });
      return res.end(rewritten);
    }

    if (!upstream.body) {
      return send(res, 502, 'text/plain; charset=utf-8', 'Empty upstream body');
    }

    const body = Readable.fromWeb(upstream.body);

    if (isTs && deint) {
      return proxyViaFfmpeg(body, res);
    }

    res.writeHead(200, {
      'Content-Type': ctype || 'application/octet-stream',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Access-Control-Allow-Origin': '*',
    });
    body.pipe(res);
  } catch (err) {
    send(res, 502, 'text/plain; charset=utf-8', `Proxy error: ${err?.message || String(err)}`);
  }
}


function transcodeFromUrl(targetUrl, res) {
  const ffmpeg = spawn('ffmpeg', [
    '-hide_banner',
    '-loglevel', 'error',
    '-fflags', 'nobuffer',
    '-flags', 'low_delay',
    '-reconnect', '1',
    '-reconnect_streamed', '1',
    '-reconnect_delay_max', '2',
    '-i', targetUrl,
    '-vf', 'yadif=0:-1:0',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-tune', 'zerolatency',
    '-pix_fmt', 'yuv420p',
    '-g', '50',
    '-keyint_min', '25',
    '-sc_threshold', '0',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-ar', '48000',
    '-ac', '2',
    '-f', 'mpegts',
    'pipe:1',
  ]);

  res.writeHead(200, {
    'Content-Type': 'video/mp2t',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'Access-Control-Allow-Origin': '*',
  });

  ffmpeg.stdout.pipe(res);

  const cleanup = () => {
    ffmpeg.kill('SIGKILL');
  };

  ffmpeg.on('error', () => {
    if (!res.headersSent) send(res, 500, 'text/plain; charset=utf-8', 'ffmpeg unavailable');
    cleanup();
  });

  ffmpeg.on('close', (code) => {
    if (code !== 0 && !res.writableEnded) {
      res.end();
    }
  });

  res.on('close', cleanup);
}

async function handleProxyTranscode(res, url) {
  const target = url.searchParams.get('url');
  if (!target) return send(res, 400, 'text/plain; charset=utf-8', 'Missing url');

  let targetUrl;
  try {
    targetUrl = new URL(target);
  } catch {
    return send(res, 400, 'text/plain; charset=utf-8', 'Invalid url');
  }

  if (!['http:', 'https:'].includes(targetUrl.protocol)) {
    return send(res, 400, 'text/plain; charset=utf-8', 'Unsupported protocol');
  }

  transcodeFromUrl(targetUrl.toString(), res);
}

function serveStatic(reqPath, res) {
  const rel = reqPath === '/' ? '/index.html' : reqPath;
  const filePath = path.join(DIST_DIR, path.normalize(rel));

  if (!filePath.startsWith(DIST_DIR)) {
    send(res, 403, 'text/plain; charset=utf-8', 'Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (!err) {
      const ext = path.extname(filePath).toLowerCase();
      send(res, 200, MIME_TYPES[ext] || 'application/octet-stream', data);
      return;
    }

    fs.readFile(path.join(DIST_DIR, 'index.html'), (indexErr, indexData) => {
      if (indexErr) {
        send(res, 500, 'text/plain; charset=utf-8', 'Build not found. Run: npm run build');
        return;
      }
      send(res, 200, 'text/html; charset=utf-8', indexData);
    });
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    send(res, 405, 'text/plain; charset=utf-8', 'Method Not Allowed');
    return;
  }

  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  if (url.pathname === '/proxy') {
    await handleProxy(req, res, url);
    return;
  }

  if (url.pathname === '/proxy-transcode') {
    await handleProxyTranscode(res, url);
    return;
  }

  serveStatic(url.pathname, res);
});

server.listen(PORT, HOST, () => {
  console.log(`IPTV app server listening on http://${HOST}:${PORT}`);
});
