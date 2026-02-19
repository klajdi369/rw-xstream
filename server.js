import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { spawn } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3004);
const HOST = '0.0.0.0';
const API_ONLY = process.env.API_ONLY === '1';
const DIST_DIR = path.join(__dirname, 'dist');
const REMUX_DIR = path.join(__dirname, '.remux');
const remuxJobs = new Map();

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
  '.m3u8': 'application/x-mpegURL',
  '.ts': 'video/mp2t',
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


function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function remuxKeyFromUrl(url, mode = 'copy') {
  return Buffer.from(`${mode}:${url}`).toString('base64url').slice(0, 40);
}

function startRemuxJob(targetUrl, mode = 'copy') {
  const key = remuxKeyFromUrl(targetUrl, mode);
  if (remuxJobs.has(key)) {
    return { key, playlistPath: path.join(REMUX_DIR, key, 'index.m3u8') };
  }

  const outDir = path.join(REMUX_DIR, key);
  ensureDir(outDir);
  const playlistPath = path.join(outDir, 'index.m3u8');

  console.log(`[REMUX] starting key=${key} mode=${mode} url=${targetUrl}`);

  const ffArgs = [
    '-hide_banner',
    '-loglevel', 'warning',
    '-fflags', 'nobuffer',
    '-reconnect', '1',
    '-reconnect_streamed', '1',
    '-reconnect_delay_max', '2',
    '-i', targetUrl,
    '-map', '0:v:0',
    '-map', '0:a:0?',
  ];

  if (mode === 'transcode') {
    ffArgs.push(
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
    );
  } else {
    ffArgs.push(
      '-c:v', 'copy',
      '-c:a', 'aac',
      '-b:a', '128k',
    );
  }

  ffArgs.push(
    '-f', 'hls',
    '-hls_time', '4',
    '-hls_list_size', '6',
    '-hls_flags', 'delete_segments+independent_segments+omit_endlist',
    '-hls_segment_filename', path.join(outDir, 'seg_%03d.ts'),
    playlistPath,
  );

  const ff = spawn('ffmpeg', ffArgs);

  ff.stderr.on('data', (buf) => {
    const line = String(buf || '').trim();
    if (line) console.log(`[REMUX:${key}] ${line}`);
  });

  ff.on('close', (code) => {
    console.log(`[REMUX] stopped key=${key} code=${code}`);
    remuxJobs.delete(key);
  });

  remuxJobs.set(key, ff);
  return { key, playlistPath };
}

async function waitForFile(filePath, timeoutMs = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (fs.existsSync(filePath)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function handleRemuxStart(res, url) {
  const target = url.searchParams.get('url');
  if (!target) return send(res, 400, 'application/json; charset=utf-8', JSON.stringify({ error: 'Missing url' }));

  let targetUrl;
  try {
    targetUrl = new URL(target);
  } catch {
    return send(res, 400, 'application/json; charset=utf-8', JSON.stringify({ error: 'Invalid url' }));
  }

  if (!['http:', 'https:'].includes(targetUrl.protocol)) {
    return send(res, 400, 'application/json; charset=utf-8', JSON.stringify({ error: 'Unsupported protocol' }));
  }

  const mode = url.searchParams.get('mode') === 'transcode' ? 'transcode' : 'copy';
  const { key, playlistPath } = startRemuxJob(targetUrl.toString(), mode);
  const ready = await waitForFile(playlistPath, 12000);

  if (!ready) {
    return send(res, 504, 'application/json; charset=utf-8', JSON.stringify({ error: 'Remux startup timeout', key }));
  }

  return send(res, 200, 'application/json; charset=utf-8', JSON.stringify({ key, mode, manifest: `/remux/hls/${key}/index.m3u8` }));
}

function serveRemuxAsset(reqPath, res) {
  const rel = reqPath.replace(/^\/remux\/hls/, '');
  const filePath = path.join(REMUX_DIR, path.normalize(rel));
  if (!filePath.startsWith(REMUX_DIR)) {
    send(res, 403, 'text/plain; charset=utf-8', 'Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      send(res, 404, 'text/plain; charset=utf-8', 'Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    send(res, 200, MIME_TYPES[ext] || 'application/octet-stream', data);
  });
}


function handleRemuxDebug(res) {
  const jobs = [...remuxJobs.entries()].map(([key, proc]) => ({ key, pid: proc.pid }));
  send(res, 200, 'application/json; charset=utf-8', JSON.stringify({ active: jobs.length, jobs }));
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
