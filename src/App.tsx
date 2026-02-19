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
  const t = s.trim();
  if (!t) return '';
  if (!/^https?:\/\//i.test(t)) return `http://${t}`.replace(/\/+$/, '');
  return t.replace(/\/+$/, '');
}

export default function App() {
  const videoRef = React.useRef<HTMLVideoElement>(null);
  const [sidebarOpen, setSidebarOpen] = React.useState(false);
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const [hudTitle, setHudTitle] = React.useState('IPTV Player');
  const [hudSub, setHudSub] = React.useState('Press OK to open channel list');

  const [server, setServer] = React.useState('http://line.tivi-ott.net');
  const [user, setUser] = React.useState('UMYLEJ');
  const [pass, setPass] = React.useState('VFCED1');
  const [fmt, setFmt] = React.useState('m3u8');
  const [remember, setRemember] = React.useState(true);
  const [msg, setMsg] = React.useState('');

  const [categories, setCategories] = React.useState<Category[]>([]);
  const [channels, setChannels] = React.useState<Channel[]>([]);
  const [selCat, setSelCat] = React.useState(0);
  const [selCh, setSelCh] = React.useState(0);

  const cacheRef = React.useRef<Map<string, Channel[]>>(new Map());
  const activeCatRef = React.useRef<string>('');
  const hlsRef = React.useRef<Hls | null>(null);
  const mtsRef = React.useRef<any>(null);

  const apiUrl = React.useCallback((params: Record<string, any>) => {
    const u = new URL(`${normServer(server)}/player_api.php`);
    u.searchParams.set('username', user);
    u.searchParams.set('password', pass);
    Object.entries(params).forEach(([k, v]) => u.searchParams.set(k, String(v)));
    return u.toString();
  }, [server, user, pass]);

  const jget = async (url: string): Promise<any> => {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  };

  const stopPlayback = React.useCallback(() => {
    hlsRef.current?.destroy();
    hlsRef.current = null;
    try { mtsRef.current?.destroy(); } catch { /* noop */ }
    mtsRef.current = null;
    if (videoRef.current) {
      videoRef.current.pause();
      videoRef.current.removeAttribute('src');
      videoRef.current.load();
    }
  }, []);

  const playChannel = React.useCallback((ch: Channel) => {
    const v = videoRef.current;
    if (!v) return;
    stopPlayback();

    const url = `${normServer(server)}/live/${encodeURIComponent(user)}/${encodeURIComponent(pass)}/${encodeURIComponent(String(ch.stream_id))}.${fmt === 'ts' ? 'ts' : 'm3u8'}`;

    if (fmt !== 'ts' && Hls.isSupported()) {
      const hls = new Hls({ lowLatencyMode: true });
      hlsRef.current = hls;
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        setHudTitle(ch.name || 'Playing');
        setHudSub('▶ Live');
        v.play().catch(() => undefined);
      });
      hls.on(Hls.Events.ERROR, (_: any, d: any) => {
        if (d?.fatal) setHudSub(`Cannot play: ${d?.details || d?.type}`);
      });
      hls.attachMedia(v);
      hls.loadSource(url);
    } else if (fmt === 'ts' && mpegts.getFeatureList().mseLivePlayback) {
      const p = mpegts.createPlayer({ type: 'mpegts', isLive: true, url }, { enableWorker: true });
      mtsRef.current = p;
      p.attachMediaElement(v);
      p.load();
      v.play().catch(() => undefined);
      setHudTitle(ch.name || 'Playing');
      setHudSub('▶ TS Live');
    } else {
      v.src = url;
      v.play().catch(() => undefined);
    }

    if (remember) {
      const last: LastChannel = {
        streamId: String(ch.stream_id),
        name: ch.name,
        catId: activeCatRef.current,
      };
      localStorage.setItem(LAST_KEY, JSON.stringify(last));
    }
  }, [fmt, pass, remember, server, stopPlayback, user]);

  const loadCategory = React.useCallback(async (cat: Category, resetSel = true) => {
    const id = String(cat.category_id);
    activeCatRef.current = id;

    if (cacheRef.current.has(id)) {
      const cached = cacheRef.current.get(id) || [];
      setChannels(cached);
      if (resetSel) setSelCh(0);
      return;
    }

    const data: any = await jget(apiUrl({ action: 'get_live_streams', category_id: id }));
    const list: Channel[] = (Array.isArray(data) ? data : []) as Channel[];
    list.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
    cacheRef.current.set(id, list);
    setChannels(list);
    if (resetSel) setSelCh(0);
  }, [apiUrl]);

  const connect = React.useCallback(async () => {
    if (!server || !user || !pass) {
      setMsg('Fill all fields');
      return;
    }

    try {
      const auth: any = await jget(apiUrl({}));
      if (!auth?.user_info?.auth) throw new Error('Auth failed');

      const raw: any = await jget(apiUrl({ action: 'get_live_categories' }));
      const all: Category[] = (Array.isArray(raw) ? raw : []) as Category[];
      const filtered = all.filter((c) => String(c.category_name || '').toUpperCase().includes('ALBANIA'));
      setCategories(filtered);
      setSelCat(0);
      cacheRef.current.clear();

      localStorage.setItem(SAVE_KEY, JSON.stringify({ server, user, pass, fmt, rememberChannel: remember }));

      if (filtered[0]) await loadCategory(filtered[0], true);

      const last: LastChannel | null = JSON.parse(localStorage.getItem(LAST_KEY) || 'null');
      if (last && remember) {
        const cat = filtered.find((c) => String(c.category_id) === String(last.catId)) || filtered[0];
        if (cat) {
          await loadCategory(cat, false);
          setSelCat(clamp(filtered.findIndex((c) => String(c.category_id) === String(cat.category_id)), 0, Math.max(0, filtered.length - 1)));
          const chs = cacheRef.current.get(String(cat.category_id)) || [];
          const idx = chs.findIndex((c) => String(c.stream_id) === String(last.streamId));
          if (idx >= 0) {
            setSelCh(idx);
            playChannel(chs[idx]);
          }
        }
      }

      setSettingsOpen(false);
      setMsg(`Connected! ${filtered.length} categories`);
    } catch (e: any) {
      setMsg(`Failed: ${e?.message || String(e)}`);
      setSettingsOpen(true);
    }
  }, [apiUrl, fmt, loadCategory, pass, playChannel, remember, server, user]);

  React.useEffect(() => {
    const saved: any = JSON.parse(localStorage.getItem(SAVE_KEY) || '{}');
    if (saved.server) setServer(saved.server);
    if (saved.user) setUser(saved.user);
    if (saved.pass) setPass(saved.pass);
    if (saved.fmt) setFmt(saved.fmt);
    if (saved.rememberChannel !== undefined) setRemember(saved.rememberChannel !== false);
    if (saved.server && saved.user && saved.pass) connect();
    else setSettingsOpen(true);
    return () => stopPlayback();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (settingsOpen) return;
      if (e.key === 'Enter' && !sidebarOpen) { setSidebarOpen(true); return; }
      if (e.key === 'Escape' || e.key === 'Backspace') { setSidebarOpen(false); return; }
      if (e.key === 'ArrowUp' && sidebarOpen) setSelCh((v) => clamp(v - 1, 0, Math.max(0, channels.length - 1)));
      if (e.key === 'ArrowDown' && sidebarOpen) setSelCh((v) => clamp(v + 1, 0, Math.max(0, channels.length - 1)));
      if (e.key === 'Enter' && sidebarOpen && channels[selCh]) { playChannel(channels[selCh]); setSidebarOpen(false); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [channels, playChannel, selCh, settingsOpen, sidebarOpen]);

  return (
    <>
      <div id="videoLayer"><video id="video" ref={videoRef} autoPlay playsInline /></div>
      <div id="backdrop" className={sidebarOpen ? 'open' : ''} onClick={() => setSidebarOpen(false)} />
      <Sidebar
        open={sidebarOpen}
        categories={categories}
        channels={channels}
        selectedCategory={selCat}
        selectedChannel={selCh}
        onPickCategory={async (i) => {
          setSelCat(i);
          if (categories[i]) await loadCategory(categories[i], true);
        }}
        onPickChannel={(i) => {
          setSelCh(i);
          if (channels[i]) {
            playChannel(channels[i]);
            setSidebarOpen(false);
          }
        }}
      />
      <Hud title={hudTitle} subtitle={hudSub} hidden={settingsOpen} onOpenSettings={() => setSettingsOpen(true)} />
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
    </>
  );
}
