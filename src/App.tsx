import React from 'react';
import Hls from 'hls.js';
import mpegts from 'mpegts.js';
import { Hud } from './components/Hud';
import { SettingsOverlay } from './components/SettingsOverlay';
import { Sidebar } from './components/Sidebar';
import { Category, Channel, LastChannel } from './types/player';

const SAVE_KEY = 'xtream_tv_v4';
const LAST_KEY = 'xtream_last_ch';

const clamp = (n: number, a: number, b: number) => Math.max(a, Math.min(b, n));

function normServer(s: string) {
  const t = (s || '').trim();
  if (!t) return '';
  if (!/^https?:\/\//i.test(t)) return `http://${t}`.replace(/\/+$/, '');
  return t.replace(/\/+$/, '');
}

function fmtTime(ts: number) {
  const d = new Date(ts * 1000);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

export default function App() {
  const videoRef = React.useRef<HTMLVideoElement>(null);
  const hlsRef = React.useRef<Hls | null>(null);
  const mtsRef = React.useRef<any>(null);
  const epgIntervalRef = React.useRef<any>(null);

  const [sidebarOpen, setSidebarOpen] = React.useState(false);
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const [connecting, setConnecting] = React.useState(false);
  const [connectMsg, setConnectMsg] = React.useState('Connecting…');
  const [connectProgress, setConnectProgress] = React.useState(0);
  const [resumeLabel, setResumeLabel] = React.useState('');
  const [focus, setFocus] = React.useState<'categories' | 'channels'>('channels');

  const [hudTitle, setHudTitle] = React.useState('IPTV Player');
  const [hudSub, setHudSub] = React.useState('Press OK to open channel list');
  const [hudHidden, setHudHidden] = React.useState(true);

  const [server, setServer] = React.useState('http://line.tivi-ott.net');
  const [user, setUser] = React.useState('UMYLEJ');
  const [pass, setPass] = React.useState('VFCED1');
  const [fmt, setFmt] = React.useState('m3u8');
  const [remember, setRemember] = React.useState(true);
  const [useProxy, setUseProxy] = React.useState(true);
  const [msg, setMsg] = React.useState('');
  const [msgIsError, setMsgIsError] = React.useState(false);
  const [settingsProgress, setSettingsProgress] = React.useState(0);

  const [allCategories, setAllCategories] = React.useState<Category[]>([]);
  const [categories, setCategories] = React.useState<Category[]>([]);
  const [channels, setChannels] = React.useState<Channel[]>([]);
  const [selCat, setSelCat] = React.useState(0);
  const [selCh, setSelCh] = React.useState(0);
  const [catQuery, setCatQuery] = React.useState('');
  const [chQuery, setChQuery] = React.useState('');
  const [playingId, setPlayingId] = React.useState<string | null>(null);
  const [buffering, setBuffering] = React.useState(false);
  const [activeCatName, setActiveCatName] = React.useState('Channels');
  const [epg, setEpg] = React.useState<{ nowTitle: string; nowTime: string; progress: number; next: string } | null>(null);

  // Channel toast (shows channel name on zap)
  const [channelToast, setChannelToast] = React.useState('');
  const toastTimerRef = React.useRef<any>(null);

  // Number zap (type channel number on remote)
  const [zapDigits, setZapDigits] = React.useState('');
  const zapTimerRef = React.useRef<any>(null);

  const cacheRef = React.useRef<Map<string, Channel[]>>(new Map());
  const activeCatRef = React.useRef<string>('');
  const hudTimerRef = React.useRef<any>(null);
  const playTokenRef = React.useRef(0);
  const preloadAbortRef = React.useRef<Map<string, AbortController>>(new Map());
  const preloadStampRef = React.useRef<Map<string, number>>(new Map());
  const backendBaseRef = React.useRef(import.meta.env.DEV
    ? `${window.location.protocol}//${window.location.hostname}:3005`
    : window.location.origin);

  const apiUrl = React.useCallback((params: Record<string, any>) => {
    const u = new URL(`${normServer(server)}/player_api.php`);
    u.searchParams.set('username', user);
    u.searchParams.set('password', pass);
    Object.entries(params).forEach(([k, v]) => u.searchParams.set(k, String(v)));
    return u.toString();
  }, [server, user, pass]);

  const jget = React.useCallback(async (url: string): Promise<any> => {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }, []);

  const showToast = React.useCallback((text: string) => {
    setChannelToast(text);
    clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setChannelToast(''), 2500);
  }, []);

  const wakeHud = React.useCallback(() => {
    setHudHidden(false);
    clearTimeout(hudTimerRef.current);
    if (!sidebarOpen && !settingsOpen) {
      hudTimerRef.current = setTimeout(() => setHudHidden(true), 3500);
    }
  }, [settingsOpen, sidebarOpen]);

  const clearEpg = React.useCallback(() => {
    clearInterval(epgIntervalRef.current);
    epgIntervalRef.current = null;
    setEpg(null);
  }, []);

  const stopEpgRefresh = React.useCallback(() => {
    clearInterval(epgIntervalRef.current);
    epgIntervalRef.current = null;
  }, []);

  const decodePossiblyBase64Utf8 = React.useCallback((value: any) => {
    const raw = value == null ? '' : String(value);
    if (!raw) return '';

    const looksBase64 = /^[A-Za-z0-9+/=\r\n]+$/.test(raw) && raw.replace(/\s+/g, '').length % 4 === 0;
    if (looksBase64) {
      try {
        const bin = atob(raw.replace(/\s+/g, ''));
        const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
        return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
      } catch {
        // fall through
      }
    }

    // Repair common UTF-8-as-Latin1 mojibake sequences, e.g. "NjÃ«"
    if (raw.includes('Ã') || raw.includes('Â')) {
      try {
        const bytes = Uint8Array.from(raw, (c) => c.charCodeAt(0) & 0xff);
        return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
      } catch {
        // noop
      }
    }

    return raw;
  }, []);

  const parseEpgTs = React.useCallback((value: any) => {
    const s = value == null ? '' : String(value).trim();
    if (!s) return 0;

    if (/^\d+$/.test(s)) {
      const n = Number(s);
      if (!Number.isFinite(n) || n <= 0) return 0;
      return n > 1e12 ? Math.floor(n / 1000) : Math.floor(n);
    }

    const normalized = s.includes('T') ? s : s.replace(' ', 'T');
    const ms = Date.parse(normalized);
    if (!Number.isNaN(ms)) return Math.floor(ms / 1000);
    return 0;
  }, []);

  const fetchEpg = React.useCallback(async (streamId: string | number) => {
    stopEpgRefresh();
    try {
      const data: any = await jget(apiUrl({ action: 'get_short_epg', stream_id: String(streamId), limit: '2' }));
      const list: any[] = data?.epg_listings || data?.Epg_listings || data?.listings || [];
      if (!list.length) return;

      const entries = list
        .map((e: any) => {
          const start = parseEpgTs(e.start_timestamp ?? e.start ?? e.start_ts ?? e.begin ?? e.from);
          const end = parseEpgTs(e.stop_timestamp ?? e.end_timestamp ?? e.end ?? e.stop ?? e.to);
          return {
            title: decodePossiblyBase64Utf8(e.title ?? e.name ?? e.programme_title ?? ''),
            start,
            end,
          };
        })
        .filter((e: any) => e.start > 0 && e.end > e.start)
        .sort((a: any, b: any) => a.start - b.start);

      if (!entries.length) return;

      const paint = () => {
        const nowSec = Date.now() / 1000;
        let cur = entries.find((e: any) => e.start <= nowSec && e.end > nowSec) || entries[0];
        if (!cur) return;
        const next = entries.find((e: any) => e.start >= cur.end) || null;
        const dur = Math.max(1, cur.end - cur.start);
        const progress = Math.min(100, Math.max(0, Math.round(((nowSec - cur.start) / dur) * 100)));
        setEpg({
          nowTitle: cur.title,
          nowTime: `${fmtTime(cur.start)} – ${fmtTime(cur.end)}`,
          progress,
          next: next ? `Next  ${fmtTime(next.start)}  ${next.title}` : '',
        });
      };

      paint();
      epgIntervalRef.current = setInterval(paint, 30000);
    } catch {
      // Keep previous EPG visible on transient EPG fetch errors
      stopEpgRefresh();
    }
  }, [apiUrl, decodePossiblyBase64Utf8, jget, parseEpgTs, stopEpgRefresh]);


  const preloadNearbyChannels = React.useCallback((list: Channel[], centerIndex: number) => {
    if (!list.length || !server || !user || !pass) return;

    const now = Date.now();
    const indices: number[] = [];
    for (let i = centerIndex - 3; i <= centerIndex + 3; i += 1) {
      if (i >= 0 && i < list.length && i !== centerIndex) indices.push(i);
    }

    const sourceFormat: 'm3u8' | 'ts' = fmt === 'ts' ? 'ts' : 'm3u8';

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
  }, [fmt, pass, server, useProxy, user]);


  React.useEffect(() => () => {
    preloadAbortRef.current.forEach((ctl) => ctl.abort());
    preloadAbortRef.current.clear();
  }, []);

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
  }, [clearEpg, stopEpgRefresh]);

  const playChannel = React.useCallback((ch: Channel, forceFmt?: 'm3u8' | 'ts') => {
    const v = videoRef.current;
    if (!v) return;

    const playToken = ++playTokenRef.current;
    const preferredFmt = forceFmt ?? (fmt === 'ts' ? 'ts' : 'm3u8');
    const attemptOrder = preferredFmt === 'ts'
      ? [
        { sourceFormat: 'ts' as const, playAs: 'ts' as const, viaProxy: false, viaTranscode: false },
        { sourceFormat: 'ts' as const, playAs: 'ts' as const, viaProxy: true, viaTranscode: false },
      ]
      : [
        { sourceFormat: 'm3u8' as const, playAs: 'm3u8' as const, viaProxy: false, viaTranscode: false },
        // { sourceFormat: 'm3u8' as const, playAs: 'm3u8' as const, viaProxy: true, viaTranscode: false },
        { sourceFormat: 'm3u8' as const, playAs: 'ts' as const, viaProxy: false, viaTranscode: true },
      ];

    const attempts = useProxy ? attemptOrder : attemptOrder.filter((a) => !a.viaProxy && !a.viaTranscode);

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
      // We wait longer specifically when switching from direct HLS to
      // proxy requests, because providers can keep the previous HLS
      // session alive for a short window and reject the new one.
      const prevAttempt = index > 0 ? attempts[index - 1] : null;
      const switchingDirectToProxy = !!(attempt.viaProxy && prevAttempt && !prevAttempt.viaProxy);
      const waitMs = switchingDirectToProxy
        ? 1800
        : (index === 0 ? 150 : 300);
      await new Promise((r) => setTimeout(r, waitMs));
      if (playToken !== playTokenRef.current) return;

      const directUrl = `${normServer(server)}/live/${encodeURIComponent(user)}/${encodeURIComponent(pass)}/${encodeURIComponent(String(ch.stream_id))}.${attempt.sourceFormat}`;
      const proxyRelative = `/proxy?url=${encodeURIComponent(directUrl)}&deint=1`;
      const proxyAbsolute = `${backendBaseRef.current}${proxyRelative}`;
      const transcodeRelative = `/proxy-transcode?url=${encodeURIComponent(directUrl)}`;
      const transcodeAbsolute = `${backendBaseRef.current}${transcodeRelative}`;
      const url = attempt.viaTranscode ? transcodeAbsolute : (attempt.viaProxy ? proxyAbsolute : directUrl);

      const modeLabel = `${attempt.playAs.toUpperCase()}${attempt.viaProxy ? ' + Proxy' : ''}${attempt.viaTranscode ? ' + FFMPEG' : ''}`;
      setHudSub(`Connecting… ${modeLabel}`);
      wakeHud();
      console.log('[Player] attempt', { index, modeLabel, url });

      let settled = false;
      let blackGuard: number | null = null;

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
          setHudSub('Cannot play this stream');
          setBuffering(false);
          wakeHud();
        }
      };


      const armBlackGuard = () => {
        clearBlackGuard();

        const startedAt = Date.now();
        const isDirectHls = attempt.playAs === 'm3u8' && !attempt.viaProxy && !attempt.viaTranscode;
        // Prefer quicker fallback for direct HLS quirks, while keeping
        // proxy/transcode windows long enough for startup.
        const maxWaitMs = attempt.viaTranscode
          ? 20000
          : (attempt.viaProxy ? 7000 : (isDirectHls ? 2600 : 4000));

        const probe = () => {
          if (settled || playToken !== playTokenRef.current) return;

          const q = v.getVideoPlaybackQuality?.();
          const frames = q ? q.totalVideoFrames : ((v as any).webkitDecodedFrameCount || 0);

          const progressed = v.currentTime > 1 || (!v.paused && v.readyState >= 3);
          const hasAudioBytes = ((v as any).webkitAudioDecodedByteCount || 0) > 0;

          if (frames > 0 || progressed || hasAudioBytes) {
            settled = true;
            clearBlackGuard();
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
        hls.on(Hls.Events.ERROR, (_: any, d: any) => {
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
          const isDirectHls = !attempt.viaProxy && !attempt.viaTranscode;
          if (isDirectHls && suspiciousDetails.has(String(d?.details || ''))) {
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
          {
            enableWorker: false,
            enableStashBuffer: true,
            lazyLoad: false,
            autoCleanupSourceBuffer: true,
          },
        );
        mtsRef.current = p;
        p.on(mpegts.Events.ERROR, (t: any, d: any) => {
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
  }, [channels, fetchEpg, fmt, pass, preloadNearbyChannels, remember, server, stopPlayback, useProxy, user, wakeHud]);

  const loadCategory = React.useCallback(async (cat: Category, resetSel = true) => {
    const id = String(cat.category_id);
    activeCatRef.current = id;
    setActiveCatName(cat.category_name || 'Channels');

    let list = cacheRef.current.get(id);
    if (!list) {
      const data: any = await jget(apiUrl({ action: 'get_live_streams', category_id: id }));
      list = Array.isArray(data) ? data : [];
      list.sort((a: any, b: any) => String(a.name || '').localeCompare(String(b.name || '')));
      cacheRef.current.set(id, list);
    }

    const q = chQuery.trim().toLowerCase();
    const visible = q ? list.filter((c) => String(c.name || '').toLowerCase().includes(q)) : list;
    setChannels(visible);
    if (resetSel) setSelCh(0);

    setHudTitle(cat.category_name || 'Channels');
    setHudSub(`${visible.length} channels`);
    wakeHud();
  }, [apiUrl, chQuery, jget, wakeHud]);

  const connect = React.useCallback(async () => {
    if (!server || !user || !pass) {
      setMsg('Fill all fields');
      setMsgIsError(true);
      return;
    }

    try {
      setConnecting(true);
      setConnectMsg('Connecting…');
      setConnectProgress(10);
      setMsg('Connecting…');
      setMsgIsError(false);
      setSettingsProgress(10);

      const auth: any = await jget(apiUrl({}));
      if (!auth?.user_info?.auth) throw new Error('Auth failed');

      setConnectMsg('Loading categories…');
      setConnectProgress(45);
      setSettingsProgress(45);

      const raw: any = await jget(apiUrl({ action: 'get_live_categories' }));
      const all = (Array.isArray(raw) ? raw : []) as Category[];
      all.sort((a, b) => Number(a.category_id) - Number(b.category_id));
      const filtered = all.filter((c) => String(c.category_name || '').toUpperCase().includes('ALBANIA'));

      setAllCategories(filtered);
      setCategories(filtered);
      setSelCat(0);
      setChQuery('');
      cacheRef.current.clear();

      localStorage.setItem(SAVE_KEY, JSON.stringify({ server, user, pass, fmt, rememberChannel: remember, useProxy }));

      setConnectMsg('Loading channels…');
      setConnectProgress(70);
      setSettingsProgress(70);

      if (filtered[0]) await loadCategory(filtered[0], true);

      setConnectProgress(90);
      setSettingsProgress(90);

      const last: LastChannel | null = JSON.parse(localStorage.getItem(LAST_KEY) || 'null');
      if (last && remember) {
        const cat = filtered.find((c) => String(c.category_id) === String(last.catId)) || filtered[0];
        if (cat) {
          await loadCategory(cat, false);
          const list = cacheRef.current.get(String(cat.category_id)) || [];
          const idx = list.findIndex((c) => String(c.stream_id) === String(last.streamId));
          const catIdx = filtered.findIndex((c) => String(c.category_id) === String(cat.category_id));
          setSelCat(catIdx >= 0 ? catIdx : 0);
          if (idx >= 0) {
            setSelCh(idx);
            playChannel(list[idx]);
            setResumeLabel(`▶ Resuming: ${last.name}`);
            setTimeout(() => setResumeLabel(''), 3200);
          }
        }
      }

      setConnectProgress(100);
      setSettingsProgress(100);
      setSettingsOpen(false);
      setMsg(`Connected! ${filtered.length} categories.`);
      setMsgIsError(false);
      setHudTitle('Ready');
      setHudSub('OK to open channel list');
      wakeHud();
    } catch (e: any) {
      const errMsg = `Failed: ${e?.message || String(e)}`;
      setMsg(errMsg);
      setMsgIsError(true);
      setSettingsProgress(0);
      setSettingsOpen(true);
    } finally {
      setConnecting(false);
      setConnectProgress(0);
    }
  }, [apiUrl, fmt, jget, loadCategory, pass, playChannel, remember, server, useProxy, user, wakeHud]);

  React.useEffect(() => {
    const saved: any = JSON.parse(localStorage.getItem(SAVE_KEY) || '{}');
    if (saved.server) setServer(saved.server);
    if (saved.user) setUser(saved.user);
    if (saved.pass) setPass(saved.pass);
    if (saved.fmt) setFmt(saved.fmt);
    if (saved.rememberChannel !== undefined) setRemember(saved.rememberChannel !== false);
    if (saved.useProxy !== undefined) setUseProxy(saved.useProxy !== false);

    if (saved.server && saved.user && saved.pass) setTimeout(() => connect(), 30);
    else setSettingsOpen(true);

    return () => {
      stopPlayback();
      clearTimeout(hudTimerRef.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);


  React.useEffect(() => {
    clearTimeout(hudTimerRef.current);
    if (!sidebarOpen && !settingsOpen && !hudHidden) {
      hudTimerRef.current = setTimeout(() => setHudHidden(true), 1800);
    }
  }, [hudHidden, settingsOpen, sidebarOpen]);

  React.useEffect(() => {
    const q = catQuery.trim().toLowerCase();
    const filtered = q ? allCategories.filter((c) => String(c.category_name || '').toLowerCase().includes(q)) : allCategories;
    setCategories(filtered);
    setSelCat(0);
  }, [allCategories, catQuery]);

  React.useEffect(() => {
    const cat = categories[selCat];
    if (!cat) return;
    loadCategory(cat, false);
  }, [chQuery]);

  // Number zap: type digits to jump to a channel number
  const executeZap = React.useCallback((digits: string) => {
    const num = parseInt(digits, 10);
    if (isNaN(num) || num < 1 || !channels.length) return;
    const idx = clamp(num - 1, 0, channels.length - 1);
    setSelCh(idx);
    const ch = channels[idx];
    if (ch) {
      playChannel(ch);
      showToast(ch.name || `Channel ${num}`);
    }
  }, [channels, playChannel, showToast]);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (settingsOpen) {
        if (e.key === 'Escape' || e.key === 'Backspace') setSettingsOpen(false);
        if (e.key === 'Enter') connect();
        return;
      }

      // Number keys for channel zapping (only when sidebar is closed and not in search)
      if (!sidebarOpen && e.key >= '0' && e.key <= '9') {
        e.preventDefault();
        const newDigits = zapDigits + e.key;
        setZapDigits(newDigits);
        clearTimeout(zapTimerRef.current);
        zapTimerRef.current = setTimeout(() => {
          executeZap(newDigits);
          setZapDigits('');
        }, 1200);
        wakeHud();
        return;
      }

      wakeHud();

      if (!sidebarOpen) {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          // Snap selection to the currently playing channel
          if (playingId && channels.length) {
            const playIdx = channels.findIndex((c) => String(c.stream_id) === playingId);
            if (playIdx >= 0) setSelCh(playIdx);
          }
          setSidebarOpen(true);
          setFocus('channels');
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          const n = clamp(selCh - 1, 0, Math.max(0, channels.length - 1));
          setSelCh(n);
          if (channels[n]) {
            playChannel(channels[n]);
            showToast(channels[n].name || 'Channel');
          }
          return;
        }
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          const n = clamp(selCh + 1, 0, Math.max(0, channels.length - 1));
          setSelCh(n);
          if (channels[n]) {
            playChannel(channels[n]);
            showToast(channels[n].name || 'Channel');
          }
        }
        return;
      }

      if (e.key === 'Escape' || e.key === 'Backspace') {
        e.preventDefault();
        if (focus === 'categories') setFocus('channels');
        else setSidebarOpen(false);
        return;
      }

      if (e.key === 'ArrowLeft' && focus === 'channels') {
        e.preventDefault();
        return setFocus('categories');
      }
      if (e.key === 'ArrowRight' && focus === 'categories') {
        e.preventDefault();
        return setFocus('channels');
      }

      if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (focus === 'categories') {
          const next = clamp(selCat - 1, 0, Math.max(0, categories.length - 1));
          setSelCat(next);
        } else {
          setSelCh((v) => clamp(v - 1, 0, Math.max(0, channels.length - 1)));
        }
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (focus === 'categories') {
          const next = clamp(selCat + 1, 0, Math.max(0, categories.length - 1));
          setSelCat(next);
        } else {
          setSelCh((v) => clamp(v + 1, 0, Math.max(0, channels.length - 1)));
        }
      }
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (focus === 'categories') {
          const cat = categories[selCat];
          if (cat) loadCategory(cat, true);
          setFocus('channels');
        } else if (channels[selCh]) {
          playChannel(channels[selCh]);
          setSidebarOpen(false);
        }
      }
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [categories, channels, connect, executeZap, focus, loadCategory, playChannel, playingId, selCat, selCh, settingsOpen, showToast, sidebarOpen, wakeHud, zapDigits]);

  return (
    <>
      <div id="videoLayer"><video id="video" ref={videoRef} autoPlay playsInline /></div>

      {/* Buffering spinner — visible while channel is loading */}
      <div id="bufferOverlay" className={buffering ? 'show' : ''}>
        <div className="bufferSpin" />
      </div>

      <div id="resumeBadge" className={resumeLabel ? 'show' : ''}>{resumeLabel}</div>

      {/* Channel toast */}
      <div id="channelToast" className={channelToast ? 'show' : ''}>{channelToast}</div>

      {/* Number zap overlay */}
      <div id="zapOverlay" className={zapDigits ? 'show' : ''}>
        {zapDigits}
        <div className="zapSub">channel</div>
      </div>

      <div id="backdrop" className={sidebarOpen ? 'open' : ''} onClick={() => setSidebarOpen(false)} />

      <Sidebar
        open={sidebarOpen}
        focus={focus}
        categories={categories}
        channels={channels}
        selectedCategory={selCat}
        selectedChannel={selCh}
        categoryQuery={catQuery}
        channelQuery={chQuery}
        playingId={playingId}
        activeCategoryName={activeCatName}
        onCategoryQuery={setCatQuery}
        onChannelQuery={setChQuery}
        onPickCategory={async (i) => {
          setSelCat(i);
          const cat = categories[i];
          if (cat) await loadCategory(cat, true);
          setFocus('channels');
        }}
        onPickChannel={(i) => {
          setSelCh(i);
          if (channels[i]) {
            playChannel(channels[i]);
            setSidebarOpen(false);
          }
        }}
      />

      <Hud title={hudTitle} subtitle={hudSub} hidden={hudHidden || settingsOpen} onOpenSettings={() => setSettingsOpen(true)} epg={epg} />

      <SettingsOverlay
        open={settingsOpen}
        server={server}
        user={user}
        pass={pass}
        fmt={fmt}
        remember={remember}
        useProxy={useProxy}
        message={msg}
        isError={msgIsError}
        progress={settingsProgress}
        onChange={(patch) => {
          if (patch.server !== undefined) setServer(patch.server);
          if (patch.user !== undefined) setUser(patch.user);
          if (patch.pass !== undefined) setPass(patch.pass);
          if (patch.fmt !== undefined) setFmt(patch.fmt);
          if (patch.remember !== undefined) setRemember(patch.remember);
          if (patch.useProxy !== undefined) setUseProxy(patch.useProxy);
        }}
        onConnect={connect}
        onClear={() => {
          localStorage.removeItem(SAVE_KEY);
          localStorage.removeItem(LAST_KEY);
          setMsg('Cleared');
          setMsgIsError(false);
          setSettingsProgress(0);
        }}
      />

      <div id="connectingScreen" className={connecting ? 'show' : ''}>
        <div className="bigSpin" />
        <div className="cMsg">{connectMsg}</div>
        <div className="progBar"><div className="progFill" style={{ width: `${connectProgress}%` }} /></div>
      </div>
    </>
  );
}
