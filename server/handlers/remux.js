import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { send } from '../utils.js';

const REMUX_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '.remux');
const remuxJobs = new Map();

const MIME_TYPES = {
  '.m3u8': 'application/x-mpegURL',
  '.ts': 'video/mp2t',
};

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
    ffArgs.push('-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k');
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

export async function handleRemuxStart(res, url) {
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

export function serveRemuxAsset(reqPath, res) {
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

export function handleRemuxDebug(res) {
  const jobs = [...remuxJobs.entries()].map(([key, proc]) => ({ key, pid: proc.pid }));
  send(res, 200, 'application/json; charset=utf-8', JSON.stringify({ active: jobs.length, jobs }));
}
