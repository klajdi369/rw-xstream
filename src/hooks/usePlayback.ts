import React from 'react';
import Hls from 'hls.js';
import type { ErrorData as HlsErrorData } from 'hls.js';
import mpegts from 'mpegts.js';
import { Channel, LastChannel } from '../types/player';
import { normServer } from '../utils';
import { CHANNEL_PROXY_MAX_VISITS, LAST_KEY } from '../constants';
import { ProxyMemoryMap } from './useProxyMemory';
import { diagnosticErrorName, diagnosticHttpStatus } from './usePlaybackDiagnostics';
import type { ReportDiagnostic } from './usePlaybackDiagnostics';
import { describeMediaState, describeStreamTracks, observeMediaMilestones, observeMpegtsDiagnostics } from '../player/playbackDiagnostics';
import { installJoinFix } from '../player/mpegtsJoinFix';

type StreamFormat = 'm3u8' | 'ts';

const MEDIA_ERROR_NAMES: Record<number, string> = { 1: 'aborted', 2: 'network error', 3: 'decode error', 4: 'format not supported' };

interface PlayAttempt {
  sourceFormat: StreamFormat;
  playAs: StreamFormat;
  viaProxy: boolean;
  viaTranscode: boolean;
}

interface UsePlaybackOptions {
  videoRef: React.RefObject<HTMLVideoElement>;
  backendBaseRef: React.MutableRefObject<string>;
  activeCatRef: React.MutableRefObject<string>;
  server: string;
  user: string;
  pass: string;
  fmt: string;
  useProxy: boolean;
  rememberProxyMode: boolean;
  /** Validate video frames with WebCodecs and skip damaged ones (extra CPU). */
  checkVideo: boolean;
  debugPlayback: boolean;
  reportDiagnostic: ReportDiagnostic;
  remember: boolean;
  fetchEpg: (id: string | number, epgChannelId?: string | null, channelName?: string) => Promise<void>;
  clearEpg: () => void;
  stopEpgRefresh: () => void;
  readChannelProxyMemory: () => ProxyMemoryMap;
  writeChannelProxyMemory: (next: ProxyMemoryMap) => void;
  setHudTitle: (t: string) => void;
  setHudSub: (t: string) => void;
  wakeHud: () => void;
}

export function usePlayback({
  videoRef,
  backendBaseRef,
  activeCatRef,
  server,
  user,
  pass,
  fmt,
  useProxy,
  rememberProxyMode,
  checkVideo,
  debugPlayback,
  reportDiagnostic,
  remember,
  fetchEpg,
  clearEpg,
  stopEpgRefresh,
  readChannelProxyMemory,
  writeChannelProxyMemory,
  setHudTitle,
  setHudSub,
  wakeHud,
}: UsePlaybackOptions) {
  const hlsRef = React.useRef<Hls | null>(null);
  const mtsRef = React.useRef<ReturnType<typeof mpegts.createPlayer> | null>(null);
  const playTokenRef = React.useRef(0);
  // Removes the per-attempt listeners we hang on the <video> element.
  const detachMediaRef = React.useRef<(() => void) | null>(null);

  const [playingId, setPlayingId] = React.useState<string | null>(null);
  const [buffering, setBuffering] = React.useState(false);

  const stopPlayback = React.useCallback((preserveEpg = false) => {
    detachMediaRef.current?.();
    detachMediaRef.current = null;
    hlsRef.current?.destroy();
    hlsRef.current = null;
    try { mtsRef.current?.destroy(); } catch { /* noop */ }
    mtsRef.current = null;
    if (preserveEpg) stopEpgRefresh();
    else clearEpg();
    if (videoRef.current) {
      videoRef.current.pause();
      videoRef.current.removeAttribute('src');
      videoRef.current.load();
    }
  }, [clearEpg, stopEpgRefresh, videoRef]);

  const resetPlayback = React.useCallback(() => {
    ++playTokenRef.current;
    stopPlayback();
    setPlayingId(null);
    setBuffering(false);
  }, [stopPlayback]);

  const playChannel = React.useCallback((ch: Channel, forceFmt?: StreamFormat) => {
    const v = videoRef.current;
    if (!v) return;

    const playToken = ++playTokenRef.current;
    const preferredFmt = forceFmt ?? (fmt === 'ts' ? 'ts' : 'm3u8');
    const attemptOrder: PlayAttempt[] = preferredFmt === 'ts'
      ? [
        { sourceFormat: 'ts', playAs: 'ts', viaProxy: false, viaTranscode: false },
        { sourceFormat: 'ts', playAs: 'ts', viaProxy: true, viaTranscode: false },
      ]
      : [
        { sourceFormat: 'm3u8', playAs: 'm3u8', viaProxy: false, viaTranscode: false },
        // { sourceFormat: 'm3u8', playAs: 'm3u8', viaProxy: true, viaTranscode: false },
        { sourceFormat: 'm3u8', playAs: 'ts', viaProxy: false, viaTranscode: true },
      ];

    const channelId = String(ch.stream_id);
    const rememberedMode = rememberProxyMode ? readChannelProxyMemory()[channelId] : null;
    const rememberedUseProxy = rememberedMode && rememberedMode.visits <= CHANNEL_PROXY_MAX_VISITS
      ? rememberedMode.useProxy
      : null;

    const reorderAttempts = (list: PlayAttempt[]) => {
      if (rememberedUseProxy === null) return list;
      const preferred = list.filter((a) => (a.viaProxy || a.viaTranscode) === rememberedUseProxy);
      const fallback = list.filter((a) => (a.viaProxy || a.viaTranscode) !== rememberedUseProxy);
      return [...preferred, ...fallback];
    };

    const attempts = useProxy
      ? reorderAttempts(attemptOrder)
      : attemptOrder.filter((a) => !a.viaProxy && !a.viaTranscode);

    if (debugPlayback) {
      reportDiagnostic(`Tune requested · ${preferredFmt === 'ts' ? 'MPEG-TS' : 'HLS'} · proxy ${useProxy ? 'on' : 'off'} · frame checking ${checkVideo && preferredFmt === 'ts' ? 'on' : 'off'} · ${attempts.length} playback route${attempts.length === 1 ? '' : 's'}.`);
    }

    const rememberChannelPlaybackMode = (loadedThroughProxy: boolean) => {
      if (!rememberProxyMode) return;
      const memory = readChannelProxyMemory();
      const prevVisits = Number(memory[channelId]?.visits || 0);
      const visits = prevVisits + 1;
      if (visits > CHANNEL_PROXY_MAX_VISITS) {
        delete memory[channelId];
      } else {
        memory[channelId] = { useProxy: loadedThroughProxy, visits };
      }
      writeChannelProxyMemory(memory);
    };

    const resetRememberedPlaybackMode = () => {
      if (!rememberProxyMode) return;
      const memory = readChannelProxyMemory();
      if (memory[channelId]) {
        delete memory[channelId];
        writeChannelProxyMemory(memory);
      }
    };

    setPlayingId(String(ch.stream_id));
    setBuffering(true);
    setHudTitle(ch.name || 'Playing');
    void fetchEpg(ch.stream_id, ch.epg_channel_id, ch.name);

    // Reconnects in a row after a stream error mid-playback, each of which
    // broke again soon after (see recoverWhilePlaying).
    let quickReconnects = 0;
    // Reconnects in a row because the stream arrived slower than real time
    // (see the TS branch); capped so a channel slow everywhere still plays.
    let slowReconnects = 0;
    let attemptNumber = 0;

    const startAttempt = async (index: number, retry = 0) => {
      if (playToken !== playTokenRef.current) return;
      const attempt = attempts[index];
      if (!attempt) {
        reportDiagnostic('No playback route is available with these settings.', 'error');
        setHudSub('Cannot play this stream');
        setBuffering(false);
        wakeHud();
        return;
      }

      stopPlayback(true);
      // Brief pause to let old connections drain — prevents 403 from
      // IPTV servers that reject concurrent connections per account.
      const prevAttempt = index > 0 ? attempts[index - 1] : null;
      const switchingRoute = retry === 0 && prevAttempt && (
        (attempt.viaProxy && !prevAttempt.viaProxy) || attempt.sourceFormat !== prevAttempt.sourceFormat
      );
      const waitMs = switchingRoute
        ? 1800
        : (retry > 0 ? 600 : (index === 0 ? 150 : 300));
      await new Promise((r) => setTimeout(r, waitMs));
      if (playToken !== playTokenRef.current) return;

      const directUrl = `${normServer(server)}/live/${encodeURIComponent(user)}/${encodeURIComponent(pass)}/${encodeURIComponent(String(ch.stream_id))}.${attempt.sourceFormat}`;
      const proxyAbsolute = `${backendBaseRef.current}/proxy?url=${encodeURIComponent(directUrl)}&deint=1`;
      const transcodeAbsolute = `${backendBaseRef.current}/proxy-transcode?url=${encodeURIComponent(directUrl)}`;
      const url = attempt.viaTranscode ? transcodeAbsolute : (attempt.viaProxy ? proxyAbsolute : directUrl);

      // Both the plain proxy and the FFMPEG transcode are fetched through our
      // own server, so surface "Proxy" in either case — the FFMPEG path reads
      // "Proxy + FFMPEG" to make clear it too came from the proxy, not direct.
      const viaServer = attempt.viaProxy || attempt.viaTranscode;
      const modeLabel = `${attempt.playAs.toUpperCase()}${viaServer ? ' + Proxy' : ''}${attempt.viaTranscode ? ' + FFMPEG' : ''}`;
      const attemptLabel = `Attempt ${++attemptNumber} · ${modeLabel}`;
      const reportAttempt: ReportDiagnostic = (message, level) => reportDiagnostic(`${attemptLabel} · ${message}`, level);
      reportAttempt(`Starting ${viaServer ? 'proxy' : 'direct'} playback${retry ? ' (retry)' : ''}.`);
      if (!viaServer && window.location.protocol === 'https:' && /^http:/i.test(url)) {
        reportAttempt('The browser may block an HTTP stream on an HTTPS page.');
      }
      setHudSub(`Connecting… ${modeLabel}`);
      wakeHud();
      console.log('[Player] attempt', { index, retry, modeLabel });

      let settled = false;
      // Frames are coming through (the black-screen guard saw them).
      let playing = false;
      let playingSince = 0;
      let blackGuard: ReturnType<typeof window.setTimeout> | null = null;
      // Some TV browsers never emit canplay or error for unsupported sources.
      const noProgressMs = viaServer ? 25000 : 15000;
      const diagnosticTimer = debugPlayback ? window.setTimeout(() => {
        if (!settled && playToken === playTokenRef.current) {
          reportAttempt(`No playback after ${noProgressMs / 1000}s (${describeMediaState(v)}).`, 'error');
        }
      }, noProgressMs) : undefined;
      const progressTimer = debugPlayback ? window.setTimeout(() => {
        if (!settled && playToken === playTokenRef.current) {
          reportAttempt(`Startup at 3s (${describeMediaState(v)}).`);
        }
      }, 3000) : undefined;

      const clearBlackGuard = () => {
        if (blackGuard !== null) {
          window.clearTimeout(blackGuard);
          blackGuard = null;
        }
      };

      // Stop trying altogether: tear the player down so hls.js doesn't keep
      // retrying segments (and holding the provider connection) in the
      // background, and tell the user why.
      const giveUp = (reason?: string) => {
        if (debugPlayback) reportAttempt(`Playback stopped (${describeMediaState(v)}).`, 'error');
        console.warn('[Player] giving up', { modeLabel, reason });
        stopPlayback(true);
        resetRememberedPlaybackMode();
        const hint = !useProxy && !viaServer && (reason || preferredFmt !== attempt.sourceFormat)
          && !/proxy|offline/i.test(reason || '')
          ? ' (try enabling the proxy in Settings)'
          : '';
        setHudSub(`Cannot play this stream${reason ? ` — ${reason}` : ''}${hint}`);
        setBuffering(false);
        wakeHud();
      };

      // `retryable`: the failure may be a one-off (a broken packet where we
      // joined the live stream, a dropped connection), so when this is the
      // last attempt left, reconnect once before giving up.
      const fallback = (reason?: string, retryable = false) => {
        if (settled || playToken !== playTokenRef.current) return;
        settled = true;
        clearBlackGuard();
        window.clearTimeout(diagnosticTimer);
        window.clearTimeout(progressTimer);

        if (attempts[index + 1]) {
          reportAttempt('Trying another playback route.');
          console.warn('[Player] fallback', { modeLabel, next: index + 1, reason });
          setHudSub(`${modeLabel} failed — retrying…`);
          wakeHud();
          setTimeout(() => { void startAttempt(index + 1); }, 200);
        } else if (retryable && retry < 1) {
          reportAttempt('Retrying the stream.');
          console.warn('[Player] reconnecting', { modeLabel, reason });
          setHudSub(`${modeLabel} stream error — reconnecting…`);
          wakeHud();
          setTimeout(() => { void startAttempt(index, retry + 1); }, 200);
        } else {
          giveUp(reason);
        }
      };

      const recoverIncompatibleStream = (reason: string) => {
        if (settled || playToken !== playTokenRef.current) return;
        if (attempt.sourceFormat === 'ts' && !viaServer && !attempts[index + 1]) {
          if (Hls.isSupported() || v.canPlayType('application/vnd.apple.mpegurl')) {
            attempts.push({ sourceFormat: 'm3u8', playAs: 'm3u8', viaProxy: false, viaTranscode: false });
            reportAttempt('TS could not start. Trying the provider’s HLS stream.');
          } else {
            reportAttempt('The browser reports no HLS playback support.');
          }
        }
        fallback(reason);
      };

      // A live stream can break after it started playing — a corrupt packet
      // from the provider is a fatal decode error in Chrome. Previously that
      // just froze the picture; reconnect instead, which also skips ahead to
      // the live edge, past the damage. A stream that keeps breaking right
      // after every reconnect still ends with a message.
      const recoverWhilePlaying = (reason: string) => {
        playing = false;
        quickReconnects = Date.now() - playingSince >= 10000 ? 0 : quickReconnects + 1;
        if (quickReconnects >= 3) {
          giveUp(reason);
          return;
        }
        console.warn('[Player] stream error while playing — reconnecting', { modeLabel, reason });
        if (debugPlayback) reportAttempt(`Playback interrupted. Reconnecting (${describeMediaState(v)}).`, 'error');
        setHudSub(`${modeLabel} stream glitch — reconnecting…`);
        setBuffering(true);
        wakeHud();
        setTimeout(() => { void startAttempt(index, 1); }, 200);
      };

      // The <video> element's own error: the browser couldn't decode what it
      // was fed. Log the real reason (e.g. PIPELINE_ERROR_DECODE) — it's the
      // only clue to what about the stream the browser dislikes.
      const describeMediaError = () => {
        const err = v.error;
        if (!err) return 'media error';
        return `${MEDIA_ERROR_NAMES[err.code] || `media error ${err.code}`}${err.message ? `: ${err.message}` : ''}`;
      };
      const onMediaError = () => {
        if (playToken !== playTokenRef.current) return;
        console.warn('[Player] <video> error', { code: v.error?.code, message: v.error?.message, modeLabel });
        const code = v.error?.code;
        const detail = v.error?.message?.match(/\b(?:PIPELINE|DEMUXER|DECODER)_ERROR_[A-Z0-9_]+\b/)?.[0];
        const label = code ? `Browser media error ${code} (${MEDIA_ERROR_NAMES[code] || 'unknown'})` : 'Browser media error';
        reportAttempt(detail ? `${label} · ${detail}` : label, 'error');
        if (playing) {
          recoverWhilePlaying(describeMediaError());
          return;
        }
        if (attempt.playAs === 'ts' && code === 4) {
          recoverIncompatibleStream(describeMediaError());
          return;
        }
        fallback(describeMediaError(), v.error?.code !== 4);
      };
      v.addEventListener('error', onMediaError);
      const stopMediaDiagnostics = debugPlayback ? observeMediaMilestones(v, reportAttempt) : undefined;
      detachMediaRef.current = () => {
        v.removeEventListener('error', onMediaError);
        stopMediaDiagnostics?.();
        window.clearTimeout(diagnosticTimer);
        window.clearTimeout(progressTimer);
      };

      // A rejected play() is not by itself a broken stream: it's rejected
      // with AbortError whenever playback is interrupted (the element errored
      // — handled above — or was paused/reloaded), and with NotAllowedError
      // when the browser blocks autoplay with sound. Previously any rejection
      // ended playback with "Cannot play this stream" after the first frame.
      const startPlaying = () => {
        v.play()?.catch((e: unknown) => {
          if (settled || playToken !== playTokenRef.current) return;
          const err = e as { name?: string; message?: string };
          console.warn('[Player] play() rejected', err?.name, err?.message);
          if (err?.name !== 'AbortError') reportAttempt(`Browser rejected play() (${diagnosticErrorName(e)}).`, 'error');
          if (err?.name === 'NotSupportedError' && attempt.playAs === 'ts') {
            recoverIncompatibleStream('the browser rejected the TS media format');
            return;
          }
          if (err?.name === 'NotAllowedError' && !v.muted) {
            reportAttempt('Autoplay with sound was blocked. Trying muted playback.');
            // Autoplay with sound blocked — play muted rather than not at all.
            v.muted = true;
            const unmute = () => {
              v.muted = false;
              window.removeEventListener('keydown', unmute, true);
              window.removeEventListener('pointerdown', unmute, true);
            };
            window.addEventListener('keydown', unmute, true);
            window.addEventListener('pointerdown', unmute, true);
            setHudSub(`▶ Live (${modeLabel}) — muted, press any key for sound`);
            wakeHud();
            v.play()?.catch((e2: unknown) => {
              if (settled || playToken !== playTokenRef.current) return;
              const err2 = e2 as { name?: string; message?: string };
              console.warn('[Player] muted play() rejected', err2?.name, err2?.message);
              if (err2?.name !== 'AbortError') reportAttempt(`Browser rejected muted play() (${diagnosticErrorName(e2)}).`, 'error');
              if (err2?.name === 'NotAllowedError') fallback('the browser blocked playback');
            });
          }
          // Any other rejection: the media 'error' event, the player's own
          // error events or the black-screen guard decide what happened.
        });
      };

      const armBlackGuard = () => {
        clearBlackGuard();

        const startedAt = Date.now();
        const isDirectHls = attempt.playAs === 'm3u8' && !attempt.viaProxy && !attempt.viaTranscode;
        // Direct TS: providers often redirect a couple of times and then send
        // a backlog burst, so the first frame can take a while; with the proxy
        // off this is the only attempt, so giving up early helps nobody.
        const maxWaitMs = viaServer ? 20000 : isDirectHls && preferredFmt === 'm3u8' ? 2600 : 8000;

        const probe = () => {
          if (settled || playToken !== playTokenRef.current) return;

          const q = v.getVideoPlaybackQuality?.();
          const frames = q ? q.totalVideoFrames : ((v as HTMLVideoElement & { webkitDecodedFrameCount?: number }).webkitDecodedFrameCount || 0);
          const progressed = v.currentTime > 1 || (!v.paused && v.readyState >= 3);
          const hasAudioBytes = ((v as HTMLVideoElement & { webkitAudioDecodedByteCount?: number }).webkitAudioDecodedByteCount || 0) > 0;

          if (frames > 0 || progressed || hasAudioBytes) {
            settled = true;
            playing = true;
            playingSince = Date.now();
            clearBlackGuard();
            window.clearTimeout(diagnosticTimer);
            window.clearTimeout(progressTimer);
            reportAttempt(v.videoWidth && v.videoHeight
              ? `Video started (${v.videoWidth} × ${v.videoHeight}).`
              : 'Playback started without reported video dimensions.');
            rememberChannelPlaybackMode(attempt.viaProxy || attempt.viaTranscode);
            setBuffering(false);
            return;
          }

          if (Date.now() - startedAt >= maxWaitMs) {
            if (debugPlayback) reportAttempt(`No video or audio progress (${describeMediaState(v)}).`, 'error');
            if (attempt.playAs === 'ts' && v.readyState >= HTMLMediaElement.HAVE_METADATA) {
              recoverIncompatibleStream('stream metadata loaded but playback never started');
            } else {
              fallback();
            }
            return;
          }

          blackGuard = window.setTimeout(probe, 800);
        };

        const firstProbeMs = isDirectHls ? 1200 : 2500;
        blackGuard = window.setTimeout(probe, firstProbeMs);
      };

      if (attempt.playAs === 'm3u8' && Hls.isSupported()) {
        reportAttempt('Using HLS.js (Media Source).');
        const hls = new Hls({ lowLatencyMode: true, maxBufferLength: 10, maxMaxBufferLength: 30 });
        hlsRef.current = hls;
        if (debugPlayback) {
          hls.once(Hls.Events.FRAG_LOADED, (_, data) => {
            if (playToken !== playTokenRef.current || hlsRef.current !== hls) return;
            reportAttempt(`HLS first segment received · ${Math.round(data.payload.byteLength / 1024)} KB.`);
          });
        }
        let playlistReported = false;
        // Xtream panels answer an offline channel with a normal-looking
        // playlist whose only segment is a placeholder clip (`/video/black.ts`).
        // No fallback can do better — the proxy or FFmpeg would just play the
        // black clip and report it as "Live" — so say it's offline and stop.
        hls.on(Hls.Events.LEVEL_LOADED, (_: unknown, data: { details?: { fragments?: { url?: string }[] } }) => {
          if (settled || playToken !== playTokenRef.current) return;
          const frags = data?.details?.fragments || [];
          if (debugPlayback && !playlistReported) {
            playlistReported = true;
            reportAttempt(`HLS media playlist received · ${frags.length} segments.`);
          }
          const isPlaceholder = (u = '') => {
            let decoded = u;
            try { decoded = decodeURIComponent(u); } catch { /* keep raw */ }
            return /\/video\/black\.ts(\?|&|$)/i.test(decoded);
          };
          if (frags.length && frags.every((f) => isPlaceholder(f.url))) {
            console.warn('[HLS] provider returned its offline placeholder', { url: frags[0]?.url });
            settled = true;
            clearBlackGuard();
            reportAttempt('Provider returned its offline placeholder.', 'error');
            giveUp('channel is offline (provider placeholder)');
          }
        });
        hls.on(Hls.Events.MANIFEST_PARSED, (_, data) => {
          if (settled || playToken !== playTokenRef.current) return;
          if (debugPlayback) {
            const level = data.levels[data.firstLevel] || data.levels[0];
            reportAttempt(`HLS manifest parsed · ${data.levels.length} variants${level ? ` · ${describeStreamTracks(level)}` : ''}.`);
          }
          setHudSub(`▶ Live (${modeLabel})`);
          startPlaying();
          armBlackGuard();
        });
        let nonFatalHlsErrorScore = 0;
        const hlsStartedAt = Date.now();
        hls.on(Hls.Events.ERROR, (_: unknown, d: HlsErrorData) => {
          if (playToken !== playTokenRef.current) return;
          console.warn('[HLS][error]', d?.type, d?.details, d?.fatal);
          const status = diagnosticHttpStatus(d?.response?.code);
          reportAttempt([`HLS ${d.details || d.type}`, status || (d.response?.code === 0 ? 'no HTTP response' : ''), d.fatal ? 'fatal' : 'recoverable'].filter(Boolean).join(' · '), 'error');
          if (d?.fatal) {
            fallback();
            return;
          }
          const isDirectHlsAttempt = !attempt.viaProxy && !attempt.viaTranscode;
          // A segment that fails with status 0 on a direct attempt was blocked
          // by the browser (almost always CORS: the playlist host allows us but
          // the segment host doesn't). hls.js treats it as retryable and would
          // keep hammering it until the black-screen guard gives up, but no
          // retry can succeed from the browser — go to the proxy path now.
          if (isDirectHlsAttempt && d?.details === 'fragLoadError' && d?.response?.code === 0) {
            console.warn('[HLS] segment blocked by browser (CORS) — skipping direct HLS', { fragUrl: d?.frag?.url });
            fallback(useProxy ? 'segments blocked (CORS)' : 'segments blocked (CORS) — enable the proxy in Settings');
            return;
          }
          const suspiciousDetails = new Set([
            'fragParsingError',
            'bufferAppendError',
            'bufferAddCodecError',
            'manifestIncompatibleCodecsError',
            'fragDecryptError',
          ]);
          if (isDirectHlsAttempt && suspiciousDetails.has(String(d?.details || ''))) {
            nonFatalHlsErrorScore += 1;
            const elapsedMs = Date.now() - hlsStartedAt;
            if (nonFatalHlsErrorScore >= 2 || elapsedMs >= 2200) {
              console.warn('[HLS] early fallback due to repeated parsing/buffer errors');
              fallback();
            }
          }
        });
        hls.attachMedia(v);
        hls.loadSource(url);
        return;
      }

      const tsFeatures = attempt.playAs === 'ts' ? mpegts.getFeatureList() : null;
      if (tsFeatures?.mseLivePlayback) {
        reportAttempt('Using MPEG-TS via Media Source.');
        const p = mpegts.createPlayer(
          { type: 'mpegts', isLive: true, url },
          { enableWorker: false, enableStashBuffer: true, lazyLoad: false, autoCleanupSourceBuffer: true },
        );
        mtsRef.current = p;
        // Make channels decodable that Chrome would otherwise reject right
        // after tuning in (open-GOP broadcast streams; see mpegtsJoinFix.ts).
        // The check is for the provider's stream as is; the proxy's ffmpeg
        // re-encodes it into a clean one, so checking that only costs CPU.
        installJoinFix(p, { checkVideo: checkVideo && !viaServer });
        if (debugPlayback) observeMpegtsDiagnostics(p, reportAttempt, () => playToken === playTokenRef.current && mtsRef.current === p);
        p.on(mpegts.Events.ERROR, (t: unknown, d: unknown, info: unknown) => {
          if (playToken !== playTokenRef.current) return;
          console.warn('[MPEGTS][error]', t, d, info);
          const errorInfo = info as { msg?: string; code?: number } | undefined;
          const msg = errorInfo?.msg;
          // An MSE error once the <video> element itself has errored is just
          // fallout from that; the element's 'error' event reports the cause.
          if (v.error) return;
          const detail = Object.values(mpegts.ErrorDetails).find((value) => value === d)
            || Object.values(mpegts.ErrorTypes).find((value) => value === t) || 'stream error';
          const status = diagnosticHttpStatus(errorInfo?.code) || msg?.match(/^HTTP [1-5]\d\d\b/)?.[0];
          const networkDetail = status || (/stream ended/i.test(msg || '') ? 'stream closed'
            : /failed to fetch|network ?error|load failed/i.test(msg || '') ? 'request failed before an HTTP response' : '');
          reportAttempt(networkDetail ? `MPEG-TS ${detail} · ${networkDetail}` : `MPEG-TS ${detail}`, 'error');
          const reason = msg ? `${String(d)}: ${msg}` : String(d || t || 'stream error');
          if (playing) {
            recoverWhilePlaying(reason);
            return;
          }
          const unsupported = d === mpegts.ErrorDetails.MEDIA_CODEC_UNSUPPORTED
            || d === mpegts.ErrorDetails.MEDIA_FORMAT_UNSUPPORTED || /unsupported|not (?:a )?supported/i.test(msg || '');
          if (unsupported) recoverIncompatibleStream(reason);
          else fallback(reason, true);
        });
        p.attachMediaElement(v);
        p.load();

        // Playback cushion, like VLC's network caching. Some providers send a
        // backlog when we connect and some don't; without one, playing right
        // at the live edge leaves a fraction of a second of buffer, and their
        // normal delivery jitter (measured at up to 1.5 s) becomes a stall
        // every few seconds. So start — and resume after a stall — only once
        // a few seconds are buffered. With a backlog that's immediate.
        const CUSHION_S = 3;
        // A transcoder usually delivers at live speed, without the initial burst
        // that lets a direct stream fill the cushion quickly.
        const STARTUP_BUFFER_WAIT_MS = viaServer ? 8000 : 3500;
        const REBUFFER_WAIT_MS = 6000;
        const bufferedAhead = () => {
          const t = v.currentTime;
          for (let i = 0; i < v.buffered.length; i++) {
            const start = v.buffered.start(i);
            const end = v.buffered.end(i);
            if (end > t && start <= Math.max(t, v.buffered.start(0)) + 0.3) return end - Math.max(t, start);
          }
          return 0;
        };
        let holdTimer: ReturnType<typeof window.setInterval> | null = null;
        const clearHold = () => {
          if (holdTimer !== null) window.clearInterval(holdTimer);
          holdTimer = null;
        };
        const hold = (afterStall: boolean) => {
          if (holdTimer !== null) return;
          const startedAt = Date.now();
          const maxWaitMs = afterStall ? REBUFFER_WAIT_MS : STARTUP_BUFFER_WAIT_MS;
          if (afterStall) {
            console.log('[Player] stalled — rebuffering', { ahead: bufferedAhead() });
            v.pause();
            setBuffering(true);
          }
          holdTimer = window.setInterval(() => {
            if (playToken !== playTokenRef.current || (!afterStall && settled)) { clearHold(); return; }
            const ahead = bufferedAhead();
            if (ahead < CUSHION_S && Date.now() - startedAt < maxWaitMs) return;
            clearHold();
            if (afterStall) setBuffering(false);
            if (debugPlayback) reportAttempt(afterStall
              ? `Resuming after ${Math.round((Date.now() - startedAt) / 100) / 10}s of buffering with ${ahead.toFixed(1)}s ready.`
              : `Calling play() with ${ahead.toFixed(1)}s buffered.`);
            startPlaying();
          }, 200);
        };
        const onWaiting = () => {
          if (!playing || v.paused || bufferedAhead() >= 0.5) return;
          if (debugPlayback) reportAttempt(`Rebuffering (${describeMediaState(v)}).`, 'error');
          hold(true);
        };
        v.addEventListener('waiting', onWaiting);

        // Now and then a connection delivers the channel slower than real
        // time: no backlog, then 0.3–0.7× for as long as it lasts (measured;
        // the provider's side — the next connection is usually fine). No
        // cushion rides that out, playback would stall every few seconds.
        // So when video keeps arriving clearly slower than it plays and the
        // buffer is low, reconnect.
        const SLOW_WINDOW_MS = 8000;
        const SLOW_RATE = 0.7;
        const edge: { at: number; end: number }[] = [];
        const slowWatch = window.setInterval(() => {
          if (playToken !== playTokenRef.current) return;
          if (!v.buffered.length) return;
          const now = Date.now();
          edge.push({ at: now, end: v.buffered.end(v.buffered.length - 1) });
          while (edge.length > 1 && now - edge[1].at >= SLOW_WINDOW_MS) edge.shift();
          const span = now - edge[0].at;
          if (span < SLOW_WINDOW_MS) return;
          const rate = (edge[edge.length - 1].end - edge[0].end) / (span / 1000);
          if (rate >= 0.95) slowReconnects = 0; // healthy again: count afresh
          if (rate >= SLOW_RATE || bufferedAhead() >= 2 || slowReconnects >= 2) return;
          slowReconnects += 1;
          console.warn('[Player] stream arrives slower than real time — reconnecting', { modeLabel, rate: rate.toFixed(2) });
          setHudSub(`${modeLabel} slow stream — reconnecting…`);
          setBuffering(true);
          wakeHud();
          settled = true;
          clearBlackGuard();
          void startAttempt(index, 1);
        }, 1000);

        const detachEarlier = detachMediaRef.current;
        detachMediaRef.current = () => {
          detachEarlier?.();
          v.removeEventListener('waiting', onWaiting);
          window.clearInterval(slowWatch);
          clearHold();
        };

        hold(false);
        setHudSub(`▶ TS Live (${modeLabel})`);
        armBlackGuard();
        return;
      }

      if (debugPlayback && tsFeatures) {
        reportAttempt(tsFeatures.msePlayback
          ? 'Media Source is available, but streaming network reads are unavailable.'
          : 'Media Source H.264/AAC playback is unavailable.');
      }
      const mimeType = attempt.playAs === 'm3u8' ? 'application/vnd.apple.mpegurl' : 'video/mp2t';
      reportAttempt(v.canPlayType(mimeType)
        ? 'Using native browser playback.'
        : `Trying native playback. The browser reports no support for ${attempt.playAs === 'm3u8' ? 'HLS' : 'MPEG-TS'}.`);
      v.src = url;
      v.oncanplay = () => {
        if (playToken !== playTokenRef.current) return;
        setHudSub(`▶ Live (${modeLabel})`);
        armBlackGuard();
      };
      startPlaying();
    };

    void startAttempt(0);

    if (remember) {
      const last: LastChannel = { streamId: String(ch.stream_id), name: ch.name, catId: activeCatRef.current };
      localStorage.setItem(LAST_KEY, JSON.stringify(last));
    }
  }, [
    activeCatRef,
    backendBaseRef,
    fetchEpg,
    fmt,
    pass,
    readChannelProxyMemory,
    remember,
    rememberProxyMode,
    checkVideo,
    debugPlayback,
    reportDiagnostic,
    server,
    setHudSub,
    setHudTitle,
    stopPlayback,
    useProxy,
    user,
    videoRef,
    wakeHud,
    writeChannelProxyMemory,
  ]);

  return { playingId, buffering, playChannel, resetPlayback };
}
