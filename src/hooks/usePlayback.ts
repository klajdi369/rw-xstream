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
  channels: Channel[];
  fetchEpg: (id: string | number) => Promise<void>;
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
  channels,
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
  const preloadAbortRef = React.useRef<Map<string, AbortController>>(new Map());
  const preloadStampRef = React.useRef<Map<string, number>>(new Map());

  const [playingId, setPlayingId] = React.useState<string | null>(null);
  const [buffering, setBuffering] = React.useState(false);

  const stopPlayback = React.useCallback((preserveEpg = false) => {
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

  const preloadNearbyChannels = React.useCallback((list: Channel[], centerIndex: number) => {
    if (!list.length || !server || !user || !pass) return;

    const now = Date.now();
    const indices: number[] = [];
    for (let i = centerIndex - 3; i <= centerIndex + 3; i += 1) {
      if (i >= 0 && i < list.length && i !== centerIndex) indices.push(i);
    }

    const sourceFormat: StreamFormat = fmt === 'ts' ? 'ts' : 'm3u8';

    for (const idx of indices) {
      const ch = list[idx];
      if (!ch) continue;
      const key = `${ch.stream_id}:${sourceFormat}`;
      const last = preloadStampRef.current.get(key) || 0;
      if (now - last < 20000) continue;
      preloadStampRef.current.set(key, now);

      const prev = preloadAbortRef.current.get(key);
      if (prev) prev.abort();

      const directUrl = `${normServer(server)}/live/${encodeURIComponent(user)}/${encodeURIComponent(pass)}/${encodeURIComponent(String(ch.stream_id))}.${sourceFormat}`;
      const warmUrl = useProxy
        ? `${backendBaseRef.current}/proxy?url=${encodeURIComponent(directUrl)}&deint=0`
        : directUrl;

      const ctl = new AbortController();
      preloadAbortRef.current.set(key, ctl);
      window.setTimeout(() => ctl.abort(), 1800);

      fetch(warmUrl, {
        method: 'GET',
        cache: 'no-store',
        mode: useProxy ? 'same-origin' : 'no-cors',
        signal: ctl.signal,
      }).catch(() => {
        // best-effort warmup only
      }).finally(() => {
        if (preloadAbortRef.current.get(key) === ctl) {
          preloadAbortRef.current.delete(key);
        }
      });
    }
  }, [backendBaseRef, fmt, pass, server, useProxy, user]);

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
    void fetchEpg(ch.stream_id);

    const currentIndex = channels.findIndex((c) => String(c.stream_id) === String(ch.stream_id));
    if (currentIndex >= 0) preloadNearbyChannels(channels, currentIndex);

    const startAttempt = async (index: number) => {
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
      const switchingDirectToProxy = !!(attempt.viaProxy && prevAttempt && !prevAttempt.viaProxy);
      const waitMs = switchingDirectToProxy
        ? 1800
        : (index === 0 ? 150 : 300);
      await new Promise((r) => setTimeout(r, waitMs));
      if (playToken !== playTokenRef.current) return;

      const directUrl = `${normServer(server)}/live/${encodeURIComponent(user)}/${encodeURIComponent(pass)}/${encodeURIComponent(String(ch.stream_id))}.${attempt.sourceFormat}`;
      const proxyAbsolute = `${backendBaseRef.current}/proxy?url=${encodeURIComponent(directUrl)}&deint=1`;
      const transcodeAbsolute = `${backendBaseRef.current}/proxy-transcode?url=${encodeURIComponent(directUrl)}`;
      const url = attempt.viaTranscode ? transcodeAbsolute : (attempt.viaProxy ? proxyAbsolute : directUrl);

      const modeLabel = `${attempt.playAs.toUpperCase()}${attempt.viaProxy ? ' + Proxy' : ''}${attempt.viaTranscode ? ' + FFMPEG' : ''}`;
      setHudSub(`Connecting… ${modeLabel}`);
      wakeHud();
      console.log('[Player] attempt', { index, modeLabel, url });

      let settled = false;
      let blackGuard: ReturnType<typeof window.setTimeout> | null = null;

      const clearBlackGuard = () => {
        if (blackGuard !== null) {
          window.clearTimeout(blackGuard);
          blackGuard = null;
        }
      };

      const fallback = () => {
        if (settled || playToken !== playTokenRef.current) return;
        settled = true;
        clearBlackGuard();

        if (attempts[index + 1]) {
          console.warn('[Player] fallback', { modeLabel, next: index + 1 });
          setHudSub(`${modeLabel} failed — retrying…`);
          wakeHud();
          setTimeout(() => { void startAttempt(index + 1); }, 200);
        } else {
          resetRememberedPlaybackMode();
          setHudSub('Cannot play this stream');
          setBuffering(false);
          wakeHud();
        }
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
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          if (playToken !== playTokenRef.current) return;
          setHudSub(`▶ Live (${modeLabel})`);
          v.play().catch(() => fallback());
          armBlackGuard();
        });
        let nonFatalHlsErrorScore = 0;
        const hlsStartedAt = Date.now();
        hls.on(Hls.Events.ERROR, (_: unknown, d: { fatal?: boolean; type?: string; details?: string }) => {
          if (playToken !== playTokenRef.current) return;
          console.warn('[HLS][error]', d?.type, d?.details, d?.fatal);
          if (d?.fatal) {
            fallback();
            return;
          }
          const suspiciousDetails = new Set([
            'fragParsingError',
            'bufferAppendError',
            'bufferAddCodecError',
            'manifestIncompatibleCodecsError',
            'fragDecryptError',
          ]);
          const isDirectHlsAttempt = !attempt.viaProxy && !attempt.viaTranscode;
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
        p.on(mpegts.Events.ERROR, (t: unknown, d: unknown) => {
          if (playToken !== playTokenRef.current) return;
          console.warn('[MPEGTS][error]', t, d);
          fallback();
        });
        p.attachMediaElement(v);
        p.load();
        v.play().catch(() => fallback());
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
      v.onerror = () => fallback();
      v.play().catch(() => fallback());
    };

    void startAttempt(0);

    if (remember) {
      const last: LastChannel = { streamId: String(ch.stream_id), name: ch.name, catId: activeCatRef.current };
      localStorage.setItem(LAST_KEY, JSON.stringify(last));
    }
  }, [
    activeCatRef,
    backendBaseRef,
    channels,
    fetchEpg,
    fmt,
    pass,
    preloadNearbyChannels,
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

  React.useEffect(() => {
    return () => {
      preloadAbortRef.current.forEach((ctl) => ctl.abort());
      preloadAbortRef.current.clear();
    };
  }, []);

  return { playingId, buffering, playChannel, stopPlayback };
}
