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

// Pipe ffmpeg's output to the response, but only commit a 200 once ffmpeg has
// actually produced a byte. If it dies first (missing binary, codec failure,
// upstream 403), we can still send a real error status instead of a 200 with a
// garbage/empty body.
function pipeFfmpegToResponse(ffmpeg, res, contentType) {
  let started = false;

  const begin = () => {
    if (started || res.headersSent) return;
    started = true;
    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Access-Control-Allow-Origin': '*',
    });
  };

  const kill = () => ffmpeg.kill('SIGKILL');

  // Register before pipe() so headers are written ahead of the first chunk.
  ffmpeg.stdout.once('data', begin);
  ffmpeg.stdout.on('error', () => {});
  ffmpeg.stdout.pipe(res);

  ffmpeg.on('error', () => {
    if (!res.headersSent) send(res, 500, 'text/plain; charset=utf-8', 'ffmpeg unavailable');
    kill();
  });

  ffmpeg.on('close', (code) => {
    if (!started && !res.headersSent) {
      send(res, 502, 'text/plain; charset=utf-8', `ffmpeg exited with code ${code}`);
    } else if (!res.writableEnded) {
      res.end();
    }
  });

  res.on('close', kill);
}

export function proxyViaFfmpeg(stream, res) {
  const ffmpeg = spawn('ffmpeg', [
    ...FFMPEG_BASE_ARGS,
    '-i', 'pipe:0',
    ...FFMPEG_TRANSCODE_ARGS,
    'pipe:1',
  ]);

  // Once ffmpeg exits, writes to its stdin raise EPIPE; an unhandled 'error'
  // on the source stream or on stdin would crash the process. Swallow both.
  ffmpeg.stdin.on('error', () => {});
  stream.on('error', () => ffmpeg.kill('SIGKILL'));
  stream.pipe(ffmpeg.stdin);

  pipeFfmpegToResponse(ffmpeg, res, 'video/mp2t');
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

  pipeFfmpegToResponse(ffmpeg, res, 'video/mp2t');
}
