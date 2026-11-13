import mpegts from 'mpegts.js';
import type { ReportDiagnostic } from '../hooks/usePlaybackDiagnostics';

const AVC_AAC = 'video/mp4; codecs="avc1.42E01E,mp4a.40.2"';
const HEVC = 'video/mp4; codecs="hvc1.1.6.L93.B0"';

export function readPlaybackEnvironment() {
  const video = document.createElement('video');
  const managedMediaSource = (window as Window & { ManagedMediaSource?: typeof MediaSource }).ManagedMediaSource;
  const mediaSource = window.MediaSource ?? managedMediaSource;
  const supported = (mime: string) => mediaSource?.isTypeSupported?.(mime) ? 'yes' : 'no';
  const browser = navigator.userAgent.replace(/https?:\/\/\S+/gi, '[URL]').replace(/[\r\n\t]/g, ' ').slice(0, 250);
  return [
    `Browser · ${browser}`,
    `Page · ${window.location.protocol === 'https:' ? 'HTTPS' : 'HTTP'} · ${window.isSecureContext ? 'secure context' : 'insecure context'} · ${navigator.onLine ? 'online' : 'offline'} · ${window.innerWidth} × ${window.innerHeight}`,
    `Media Source · ${window.MediaSource ? 'available' : 'unavailable'} · Managed Media Source ${managedMediaSource ? 'available' : 'unavailable'}`,
    `Media Source codecs · H.264/AAC ${supported(AVC_AAC)} · HEVC ${supported(HEVC)}`,
    `Native playback · HLS ${video.canPlayType('application/vnd.apple.mpegurl') || 'no'} · MPEG-TS ${video.canPlayType('video/mp2t') || 'no'}`,
    `Browser APIs · streaming fetch ${typeof window.fetch === 'function' && typeof window.ReadableStream === 'function' ? 'yes' : 'no'} · WebCodecs video ${'VideoDecoder' in window ? 'yes' : 'no'}`,
  ];
}

export function describeMediaState(video: HTMLVideoElement) {
  const time = video.currentTime;
  let ahead = 0;
  const ranges = video.buffered;
  for (let i = 0; i < ranges.length; i++) {
    if (ranges.start(i) <= time && time <= ranges.end(i)) {
      ahead = ranges.end(i) - time;
      break;
    }
  }
  const quality = video.getVideoPlaybackQuality?.();
  return `readyState ${video.readyState}, networkState ${video.networkState}, ${video.paused ? 'paused' : 'unpaused'}, time ${time.toFixed(1)}s, buffered ${ahead.toFixed(1)}s, ${video.videoWidth} × ${video.videoHeight}`
    + (quality ? `, ${quality.totalVideoFrames} frames, ${quality.droppedVideoFrames} dropped` : '');
}

const MILESTONES = {
  loadstart: 'Browser began loading',
  loadedmetadata: 'Media metadata available',
  loadeddata: 'First media data available',
  canplay: 'Browser can start playback',
  playing: 'Browser emitted playing',
  waiting: 'Browser waiting for more media',
  stalled: 'Browser reported a stalled download',
  encrypted: 'Browser reported encrypted media',
  ended: 'Browser reported end of stream',
} as const;

export function observeMediaMilestones(video: HTMLVideoElement, report: ReportDiagnostic) {
  const events = Object.keys(MILESTONES) as (keyof typeof MILESTONES)[];
  const seen = new Set<string>();
  const onEvent = (event: Event) => {
    if (seen.has(event.type)) return;
    seen.add(event.type);
    const type = event.type as keyof typeof MILESTONES;
    const level = type === 'stalled' || type === 'ended' || type === 'encrypted' ? 'error' : 'info';
    report(`${MILESTONES[type]} (${describeMediaState(video)}).`, level);
  };
  events.forEach((event) => video.addEventListener(event, onEvent));

  const frameCallback = video.requestVideoFrameCallback?.((_, frame) => {
    report(`First video frame presented (${frame.width} × ${frame.height}, media time ${frame.mediaTime.toFixed(2)}s).`);
  });
  return () => {
    events.forEach((event) => video.removeEventListener(event, onEvent));
    if (frameCallback !== undefined) video.cancelVideoFrameCallback?.(frameCallback);
  };
}

function knownCodec(value: unknown) {
  return typeof value === 'string' && value.length <= 48
    && /^(avc[13]|hvc1|hev1|mp4a|ac-3|ec-3|opus|av01|vp09|mp3|aac)(\.[a-z0-9]+)*$/i.test(value) ? value : '';
}

export function describeStreamTracks({ width, height, videoCodec, audioCodec }: {
  width?: unknown; height?: unknown; videoCodec?: unknown; audioCodec?: unknown;
}) {
  const resolution = typeof width === 'number' && typeof height === 'number'
    && width > 0 && height > 0 ? `${width} × ${height}` : '';
  return [resolution, knownCodec(videoCodec), knownCodec(audioCodec)].filter(Boolean).join(' · ') || 'track details unavailable';
}

export function observeMpegtsDiagnostics(
  player: ReturnType<typeof mpegts.createPlayer>,
  report: ReportDiagnostic,
  isCurrent: () => boolean,
) {
  let lastTracks = '';
  let reportedSpeed = false;
  player.on(mpegts.Events.MEDIA_INFO, (info: Parameters<typeof describeStreamTracks>[0]) => {
    if (!isCurrent() || !info) return;
    const tracks = describeStreamTracks(info);
    if (tracks === lastTracks) return;
    lastTracks = tracks;
    report(`MPEG-TS tracks · ${tracks}.`);
    const mediaSource = window.MediaSource ?? (window as Window & { ManagedMediaSource?: typeof MediaSource }).ManagedMediaSource;
    if (typeof mediaSource?.isTypeSupported !== 'function') return;
    const video = knownCodec(info.videoCodec);
    const audio = knownCodec(info.audioCodec);
    // mpegts.js uses a raw MPEG audio SourceBuffer for MP3 outside Firefox.
    const audioMime = audio === 'mp3' && !/Firefox\//i.test(navigator.userAgent)
      ? 'audio/mpeg' : `audio/mp4; codecs="${audio}"`;
    const support = (type: string) => mediaSource.isTypeSupported(type) ? 'yes' : 'no';
    const videoSupport = video ? `${video} ${support(`video/mp4; codecs="${video}"`)}` : '';
    const audioSupport = audio ? `${audio} ${support(audioMime)}` : '';
    const reportedSupport = [videoSupport, audioSupport].filter(Boolean).join(' · ');
    if (reportedSupport) report(`Media Source support for these tracks · ${reportedSupport}.`);
  });
  player.on(mpegts.Events.STATISTICS_INFO, (stats: { speed?: number; hasRedirect?: boolean }) => {
    if (reportedSpeed || !isCurrent() || !stats?.speed || !Number.isFinite(stats.speed)) return;
    reportedSpeed = true;
    report(`MPEG-TS receiving data · ${Math.round(stats.speed)} KB/s${stats.hasRedirect ? ' after a redirect' : ''}.`);
  });
}
