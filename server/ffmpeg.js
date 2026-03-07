import { spawn } from 'node:child_process';
import { send } from './utils.js';

const FFMPEG_TRANSCODE_ARGS = [
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
];

const FFMPEG_BASE_ARGS = [
  '-hide_banner',
  '-loglevel', 'error',
  '-fflags', 'nobuffer',
  '-flags', 'low_delay',
];

function attachCleanupHandlers(ffmpeg, res) {
  const cleanup = () => ffmpeg.kill('SIGKILL');

  ffmpeg.on('error', () => {
    if (!res.headersSent) send(res, 500, 'text/plain; charset=utf-8', 'ffmpeg unavailable');
    cleanup();
  });

  ffmpeg.on('close', (code) => {
    if (code !== 0 && !res.writableEnded) res.end();
  });

  res.on('close', cleanup);
}

export function proxyViaFfmpeg(stream, res) {
  const ffmpeg = spawn('ffmpeg', [
    ...FFMPEG_BASE_ARGS,
    '-i', 'pipe:0',
    ...FFMPEG_TRANSCODE_ARGS,
    'pipe:1',
  ]);

  res.writeHead(200, {
    'Content-Type': 'video/mp2t',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'Access-Control-Allow-Origin': '*',
  });

  stream.pipe(ffmpeg.stdin);
  ffmpeg.stdout.pipe(res);
  attachCleanupHandlers(ffmpeg, res);
}

export function transcodeFromUrl(targetUrl, res) {
  const ffmpeg = spawn('ffmpeg', [
    ...FFMPEG_BASE_ARGS,
    '-reconnect', '1',
    '-reconnect_streamed', '1',
    '-reconnect_delay_max', '2',
    '-i', targetUrl,
    ...FFMPEG_TRANSCODE_ARGS,
    'pipe:1',
  ]);

  res.writeHead(200, {
    'Content-Type': 'video/mp2t',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'Access-Control-Allow-Origin': '*',
  });

  ffmpeg.stdout.pipe(res);
  attachCleanupHandlers(ffmpeg, res);
}
