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

  const [allCategories, setAllCategories] = React.useState<Category[]>([]);
  const [categories, setCategories] = React.useState<Category[]>([]);
  const [channels, setChannels] = React.useState<Channel[]>([]);
  const [selCat, setSelCat] = React.useState(0);
  const [selCh, setSelCh] = React.useState(0);
  const [catQuery, setCatQuery] = React.useState('');
  const [chQuery, setChQuery] = React.useState('');
  const [playingId, setPlayingId] = React.useState<string | null>(null);
  const [epg, setEpg] = React.useState<{ nowTitle: string; nowTime: string; progress: number; next: string } | null>(null);

  const cacheRef = React.useRef<Map<string, Channel[]>>(new Map());
  const activeCatRef = React.useRef<string>('');
  const hudTimerRef = React.useRef<any>(null);
  const playTokenRef = React.useRef(0);

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

  const fetchEpg = React.useCallback(async (streamId: string | number) => {
    clearEpg();
    try {
      const data: any = await jget(apiUrl({ action: 'get_short_epg', stream_id: String(streamId), limit: '2' }));
      const list: any[] = data?.epg_listings || data?.Epg_listings || [];
      if (!list.length) return;
      const decode = (s: string) => {
        try { return atob(s); } catch { return s; }
      };
      const entries = list.map((e: any) => ({
        title: decode(e.title || e.name || ''),
        start: parseInt(e.start || e.start_timestamp || 0, 10),
        end: parseInt(e.end || e.stop_timestamp || e.end_timestamp || 0, 10),
      }));

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
      clearEpg();
    }
  }, [apiUrl, clearEpg, jget]);

  const stopPlayback = React.useCallback(() => {
    hlsRef.current?.destroy();
    hlsRef.current = null;
    try { mtsRef.current?.destroy(); } catch { /* noop */ }
    mtsRef.current = null;
    clearEpg();
    if (videoRef.current) {
      videoRef.current.pause();
      videoRef.current.removeAttribute('src');
      videoRef.current.load();
    }
  }, [clearEpg]);

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
        { sourceFormat: 'm3u8' as const, playAs: 'm3u8' as const, viaProxy: true, viaTranscode: false },
        { sourceFormat: 'm3u8' as const, playAs: 'ts' as const, viaProxy: false, viaTranscode: true },
      ];

    const attempts = useProxy ? attemptOrder : attemptOrder.filter((a) => !a.viaProxy && !a.viaTranscode);

    setPlayingId(String(ch.stream_id));
    setHudTitle(ch.name || 'Playing');
    const startAttempt = async (index: number) => {
      if (playToken !== playTokenRef.current) return;
      const attempt = attempts[index];
      if (!attempt) {
        setHudSub('Cannot play this stream');
        wakeHud();
        return;
      }

      stopPlayback();

      const directUrl = `${normServer(server)}/live/${encodeURIComponent(user)}/${encodeURIComponent(pass)}/${encodeURIComponent(String(ch.stream_id))}.${attempt.sourceFormat}`;
      const proxyRelative = `/proxy?url=${encodeURIComponent(directUrl)}&deint=1`;
      const proxyAbsolute = `${window.location.origin}${proxyRelative}`;
      const transcodeRelative = `/proxy-transcode?url=${encodeURIComponent(directUrl)}`;
      const transcodeAbsolute = `${window.location.origin}${transcodeRelative}`;
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
          setHudSub(`⚠ ${modeLabel} failed — retrying…`);
          wakeHud();
          setTimeout(() => { void startAttempt(index + 1); }, 200);
        } else {
          setHudSub('Cannot play this stream');
          wakeHud();
        }
      };


      const armBlackGuard = () => {
        clearBlackGuard();

        const startedAt = Date.now();
        const maxWaitMs = attempt.viaTranscode ? 30000 : (attempt.viaProxy ? 18000 : 10000);

        const probe = () => {
          if (settled || playToken !== playTokenRef.current) return;

          const q = v.getVideoPlaybackQuality?.();
          const frames = q ? q.totalVideoFrames : ((v as any).webkitDecodedFrameCount || 0);

          const progressed = v.currentTime > 1 || (!v.paused && v.readyState >= 3);
          const hasAudioBytes = ((v as any).webkitAudioDecodedByteCount || 0) > 0;

          if (frames > 0 || progressed || hasAudioBytes) {
            settled = true;
            clearBlackGuard();
            return;
          }

          if (Date.now() - startedAt >= maxWaitMs) {
            fallback();
            return;
          }

          blackGuard = window.setTimeout(probe, 1800);
        };

        blackGuard = window.setTimeout(probe, 6500);
      };

      if (attempt.playAs === 'm3u8' && Hls.isSupported()) {
        const hls = new Hls({ lowLatencyMode: true, maxBufferLength: 10, maxMaxBufferLength: 30 });
        hlsRef.current = hls;
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          if (playToken !== playTokenRef.current) return;
          setHudSub(`▶ Live (${modeLabel})`);
          v.play().catch(() => fallback());
          fetchEpg(ch.stream_id);
          armBlackGuard();
        });
        hls.on(Hls.Events.ERROR, (_: any, d: any) => {
          if (playToken !== playTokenRef.current) return;
          console.warn('[HLS][error]', d?.type, d?.details, d?.fatal);
          if (d?.fatal) fallback();
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
        fetchEpg(ch.stream_id);
        armBlackGuard();
        return;
      }

      v.src = url;
      v.oncanplay = () => {
        if (playToken !== playTokenRef.current) return;
        setHudSub(`▶ Live (${modeLabel})`);
        fetchEpg(ch.stream_id);
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
  }, [fetchEpg, fmt, pass, remember, server, stopPlayback, useProxy, user, wakeHud]);

  const loadCategory = React.useCallback(async (cat: Category, resetSel = true) => {
    const id = String(cat.category_id);
    activeCatRef.current = id;

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
    if (!server || !user || !pass) return setMsg('Fill all fields');

    try {
      setConnecting(true);
      setMsg('Connecting…');

      const auth: any = await jget(apiUrl({}));
      if (!auth?.user_info?.auth) throw new Error('Auth failed');

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

      if (filtered[0]) await loadCategory(filtered[0], true);

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

      setSettingsOpen(false);
      setMsg(`Connected! ${filtered.length} categories.`);
      setHudTitle('Ready');
      setHudSub('OK to open channel list');
      wakeHud();
    } catch (e: any) {
      setMsg(`Failed: ${e?.message || String(e)}`);
      setSettingsOpen(true);
    } finally {
      setConnecting(false);
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

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (settingsOpen) {
        if (e.key === 'Escape' || e.key === 'Backspace') setSettingsOpen(false);
        return;
      }

      wakeHud();

      if (!sidebarOpen) {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          setSidebarOpen(true);
          setFocus('channels');
          return;
        }
        if (e.key === 'ArrowUp') {
          const n = clamp(selCh - 1, 0, Math.max(0, channels.length - 1));
          setSelCh(n);
          if (channels[n]) playChannel(channels[n]);
          return;
        }
        if (e.key === 'ArrowDown') {
          const n = clamp(selCh + 1, 0, Math.max(0, channels.length - 1));
          setSelCh(n);
          if (channels[n]) playChannel(channels[n]);
        }
        return;
      }

      if (e.key === 'Escape' || e.key === 'Backspace') {
        if (focus === 'categories') setFocus('channels');
        else setSidebarOpen(false);
        return;
      }

      if (e.key === 'ArrowLeft' && focus === 'channels') return setFocus('categories');
      if (e.key === 'ArrowRight' && focus === 'categories') return setFocus('channels');

      if (e.key === 'ArrowUp') {
        if (focus === 'categories') {
          const next = clamp(selCat - 1, 0, Math.max(0, categories.length - 1));
          setSelCat(next);
        } else {
          setSelCh((v) => clamp(v - 1, 0, Math.max(0, channels.length - 1)));
        }
      }
      if (e.key === 'ArrowDown') {
        if (focus === 'categories') {
          const next = clamp(selCat + 1, 0, Math.max(0, categories.length - 1));
          setSelCat(next);
        } else {
          setSelCh((v) => clamp(v + 1, 0, Math.max(0, channels.length - 1)));
        }
      }
      if (e.key === 'Enter' || e.key === ' ') {
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
  }, [categories, channels, connect, focus, loadCategory, playChannel, selCat, selCh, settingsOpen, sidebarOpen, wakeHud]);

  return (
    <>
      <div id="videoLayer"><video id="video" ref={videoRef} autoPlay playsInline /></div>

      <div id="resumeBadge" className={resumeLabel ? 'show' : ''}>{resumeLabel}</div>

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
        }}
      />

      <div id="connectingScreen" className={connecting ? 'show' : ''}>
        <div className="bigSpin" />
        <div className="cMsg">Connecting…</div>
      </div>
    </>
  );
}
