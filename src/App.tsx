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

    stopPlayback();
    const effective = forceFmt ?? (fmt === 'ts' ? 'ts' : 'm3u8');
    const url = `${normServer(server)}/live/${encodeURIComponent(user)}/${encodeURIComponent(pass)}/${encodeURIComponent(String(ch.stream_id))}.${effective}`;

    setPlayingId(String(ch.stream_id));
    setHudTitle(ch.name || 'Playing');
    setHudSub('Connecting…');
    wakeHud();

    const fallback = () => {
      if (effective === 'm3u8') {
        setHudSub('⚠ Trying TS stream…');
        setTimeout(() => playChannel(ch, 'ts'), 180);
      } else {
        setHudSub('Cannot play this stream');
      }
    };

    if (effective === 'm3u8' && Hls.isSupported()) {
      const hls = new Hls({ lowLatencyMode: true, maxBufferLength: 10, maxMaxBufferLength: 30 });
      hlsRef.current = hls;
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        setHudSub('▶ Live');
        v.play().catch(() => undefined);
        fetchEpg(ch.stream_id);
      });
      hls.on(Hls.Events.ERROR, (_: any, d: any) => {
        if (d?.fatal) fallback();
      });
      hls.attachMedia(v);
      hls.loadSource(url);
    } else if (effective === 'ts' && mpegts.getFeatureList().mseLivePlayback) {
      const p = mpegts.createPlayer({ type: 'mpegts', isLive: true, url }, { enableWorker: true });
      mtsRef.current = p;
      p.attachMediaElement(v);
      p.load();
      v.play().catch(() => undefined);
      setHudSub('▶ TS Live');
      fetchEpg(ch.stream_id);
    } else {
      v.src = url;
      v.oncanplay = () => {
        setHudSub('▶ Live');
        fetchEpg(ch.stream_id);
      };
      v.play().catch(() => fallback());
    }

    if (remember) {
      const last: LastChannel = { streamId: String(ch.stream_id), name: ch.name, catId: activeCatRef.current };
      localStorage.setItem(LAST_KEY, JSON.stringify(last));
    }
  }, [fetchEpg, fmt, pass, remember, server, stopPlayback, user, wakeHud]);

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

      localStorage.setItem(SAVE_KEY, JSON.stringify({ server, user, pass, fmt, rememberChannel: remember }));

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
  }, [apiUrl, fmt, jget, loadCategory, pass, playChannel, remember, server, user, wakeHud]);

  React.useEffect(() => {
    const saved: any = JSON.parse(localStorage.getItem(SAVE_KEY) || '{}');
    if (saved.server) setServer(saved.server);
    if (saved.user) setUser(saved.user);
    if (saved.pass) setPass(saved.pass);
    if (saved.fmt) setFmt(saved.fmt);
    if (saved.rememberChannel !== undefined) setRemember(saved.rememberChannel !== false);

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
        message={msg}
        onChange={(patch) => {
          if (patch.server !== undefined) setServer(patch.server);
          if (patch.user !== undefined) setUser(patch.user);
          if (patch.pass !== undefined) setPass(patch.pass);
          if (patch.fmt !== undefined) setFmt(patch.fmt);
          if (patch.remember !== undefined) setRemember(patch.remember);
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
