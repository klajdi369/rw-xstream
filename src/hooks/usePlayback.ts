import React from 'react';
import Hls from 'hls.js';
import mpegts from 'mpegts.js';
import { Channel, LastChannel } from '../types/player';
import { normServer } from '../utils';
import { CHANNEL_PROXY_MAX_VISITS, LAST_KEY } from '../constants';
import { ProxyMemoryMap } from './useProxyMemory';

type StreamFormat = 'm3u8' | 'ts';

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

    const startAttempt = async (index: number, retry = 0) => {
      if (playToken !== playTokenRef.current) return;
      const attempt = attempts[index];
      if (!attempt) {
        setHudSub('Cannot play this stream');
        setBuffering(false);
        wakeHud();
        return;
      }

      stopPlayback(true);
      // Brief pause to let old connections drain — prevents 403 from
      // IPTV servers that reject concurrent connections per account.
      const prevAttempt = index > 0 ? attempts[index - 1] : null;
      const switchingDirectToProxy = !!(retry === 0 && attempt.viaProxy && prevAttempt && !prevAttempt.viaProxy);
      const waitMs = switchingDirectToProxy
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
      setHudSub(`Connecting… ${modeLabel}`);
      wakeHud();
      console.log('[Player] attempt', { index, retry, modeLabel, url });

      let settled = false;
      let blackGuard: ReturnType<typeof window.setTimeout> | null = null;

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
        console.warn('[Player] giving up', { modeLabel, reason });
        stopPlayback(true);
        resetRememberedPlaybackMode();
        const hint = !useProxy && !attempt.viaProxy && !attempt.viaTranscode && reason && !/proxy|offline/i.test(reason)
          ? ' (try enabling the proxy in Settings)'
          : '';
        setHudSub(reason ? `Cannot play this stream — ${reason}${hint}` : 'Cannot play this stream');
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

        if (attempts[index + 1]) {
          console.warn('[Player] fallback', { modeLabel, next: index + 1, reason });
          setHudSub(`${modeLabel} failed — retrying…`);
          wakeHud();
          setTimeout(() => { void startAttempt(index + 1); }, 200);
        } else if (retryable && retry < 1) {
          console.warn('[Player] reconnecting', { modeLabel, reason });
          setHudSub(`${modeLabel} stream error — reconnecting…`);
          wakeHud();
          setTimeout(() => { void startAttempt(index, retry + 1); }, 200);
        } else {
          giveUp(reason);
        }
      };

      // The <video> element's own error: the browser couldn't decode what it
      // was fed. Log the real reason (e.g. PIPELINE_ERROR_DECODE) — it's the
      // only clue to what about the stream the browser dislikes.
      const describeMediaError = () => {
        const err = v.error;
        if (!err) return 'media error';
        const names: Record<number, string> = { 1: 'aborted', 2: 'network error', 3: 'decode error', 4: 'format not supported' };
        return `${names[err.code] || `media error ${err.code}`}${err.message ? `: ${err.message}` : ''}`;
      };
      const onMediaError = () => {
        if (playToken !== playTokenRef.current) return;
        console.warn('[Player] <video> error', { code: v.error?.code, message: v.error?.message, modeLabel });
        fallback(describeMediaError(), v.error?.code !== 4);
      };
      v.addEventListener('error', onMediaError);
      detachMediaRef.current = () => v.removeEventListener('error', onMediaError);

      // A rejected play() is not by itself a broken stream: it's rejected
      // with AbortError whenever playback is interrupted (the element errored
      // — handled above — or was paused/reloaded), and with NotAllowedError
      // when the browser blocks autoplay with sound. Previously any rejection
      // ended playback with "Cannot play this stream" after the first frame.
      const startPlaying = () => {
        v.play().catch((e: unknown) => {
          if (settled || playToken !== playTokenRef.current) return;
          const err = e as { name?: string; message?: string };
          console.warn('[Player] play() rejected', err?.name, err?.message);
          if (err?.name === 'NotAllowedError' && !v.muted) {
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
            v.play().catch((e2: unknown) => {
              if (settled || playToken !== playTokenRef.current) return;
              const err2 = e2 as { name?: string; message?: string };
              console.warn('[Player] muted play() rejected', err2?.name, err2?.message);
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
        const maxWaitMs = attempt.viaTranscode
          ? 20000
          : (attempt.viaProxy ? 7000 : (isDirectHls ? 2600 : 4000));

        const probe = () => {
          if (settled || playToken !== playTokenRef.current) return;

          const q = v.getVideoPlaybackQuality?.();
          const frames = q ? q.totalVideoFrames : ((v as HTMLVideoElement & { webkitDecodedFrameCount?: number }).webkitDecodedFrameCount || 0);
          const progressed = v.currentTime > 1 || (!v.paused && v.readyState >= 3);
          const hasAudioBytes = ((v as HTMLVideoElement & { webkitAudioDecodedByteCount?: number }).webkitAudioDecodedByteCount || 0) > 0;

          if (frames > 0 || progressed || hasAudioBytes) {
            settled = true;
            clearBlackGuard();
            rememberChannelPlaybackMode(attempt.viaProxy || attempt.viaTranscode);
            setBuffering(false);
            return;
          }

          if (Date.now() - startedAt >= maxWaitMs) {
            fallback();
            return;
          }

          blackGuard = window.setTimeout(probe, 800);
        };

        const firstProbeMs = isDirectHls ? 1200 : 2500;
        blackGuard = window.setTimeout(probe, firstProbeMs);
      };

      if (attempt.playAs === 'm3u8' && Hls.isSupported()) {
        const hls = new Hls({ lowLatencyMode: true, maxBufferLength: 10, maxMaxBufferLength: 30 });
        hlsRef.current = hls;
        // Xtream panels answer an offline channel with a normal-looking
        // playlist whose only segment is a placeholder clip (`/video/black.ts`).
        // No fallback can do better — the proxy or FFmpeg would just play the
        // black clip and report it as "Live" — so say it's offline and stop.
        hls.on(Hls.Events.LEVEL_LOADED, (_: unknown, data: { details?: { fragments?: { url?: string }[] } }) => {
          if (settled || playToken !== playTokenRef.current) return;
          const frags = data?.details?.fragments || [];
          const isPlaceholder = (u = '') => {
            let decoded = u;
            try { decoded = decodeURIComponent(u); } catch { /* keep raw */ }
            return /\/video\/black\.ts(\?|&|$)/i.test(decoded);
          };
          if (frags.length && frags.every((f) => isPlaceholder(f.url))) {
            console.warn('[HLS] provider returned its offline placeholder', { url: frags[0]?.url });
            settled = true;
            clearBlackGuard();
            giveUp('channel is offline (provider placeholder)');
          }
        });
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          if (settled || playToken !== playTokenRef.current) return;
          setHudSub(`▶ Live (${modeLabel})`);
          startPlaying();
          armBlackGuard();
        });
        let nonFatalHlsErrorScore = 0;
        const hlsStartedAt = Date.now();
        hls.on(Hls.Events.ERROR, (_: unknown, d: {
          fatal?: boolean;
          type?: string;
          details?: string;
          response?: { code?: number };
          frag?: { url?: string };
        }) => {
          if (playToken !== playTokenRef.current) return;
          console.warn('[HLS][error]', d?.type, d?.details, d?.fatal);
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

      if (attempt.playAs === 'ts' && mpegts.getFeatureList().mseLivePlayback) {
        const p = mpegts.createPlayer(
          { type: 'mpegts', isLive: true, url },
          { enableWorker: false, enableStashBuffer: true, lazyLoad: false, autoCleanupSourceBuffer: true },
        );
        mtsRef.current = p;
        p.on(mpegts.Events.ERROR, (t: unknown, d: unknown, info: unknown) => {
          if (playToken !== playTokenRef.current) return;
          console.warn('[MPEGTS][error]', t, d, info);
          const msg = (info as { msg?: string } | undefined)?.msg;
          // An MSE error once the <video> element itself has errored is just
          // fallout from that; the element's 'error' event reports the cause.
          if (v.error) return;
          const unsupported = /unsupported|not supported/i.test(String(msg || ''));
          fallback(msg ? `${String(d)}: ${msg}` : String(d || t || 'stream error'), !unsupported);
        });
        p.attachMediaElement(v);
        p.load();
        startPlaying();
        setHudSub(`▶ TS Live (${modeLabel})`);
        armBlackGuard();
        return;
      }

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

  return { playingId, buffering, playChannel, stopPlayback };
}
