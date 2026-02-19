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
  const hlsRef = React.useRef<Hls | null>(null);
  const mtsRef = React.useRef<any>(null);

  const [sidebarOpen, setSidebarOpen] = React.useState(false);
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const [connecting, setConnecting] = React.useState(false);
  const [resumeLabel, setResumeLabel] = React.useState('');

  const [hudTitle, setHudTitle] = React.useState('IPTV Player');
  const [hudSub, setHudSub] = React.useState('Press OK to open channel list');

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

  const cacheRef = React.useRef<Map<string, Channel[]>>(new Map());
  const activeCatRef = React.useRef<string>('');

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

  const playChannel = React.useCallback((ch: Channel, forceFmt?: 'm3u8' | 'ts') => {
    const v = videoRef.current;
    if (!v) return;

    stopPlayback();
    const effective = forceFmt ?? (fmt === 'ts' ? 'ts' : 'm3u8');
    const url = `${normServer(server)}/live/${encodeURIComponent(user)}/${encodeURIComponent(pass)}/${encodeURIComponent(String(ch.stream_id))}.${effective}`;

    setPlayingId(String(ch.stream_id));
    setHudTitle(ch.name || 'Playing');
    setHudSub('Connecting…');

    const fallback = () => {
      if (effective === 'm3u8') playChannel(ch, 'ts');
      else setHudSub('Cannot play this stream');
    };

    if (effective === 'm3u8' && Hls.isSupported()) {
      const hls = new Hls({ lowLatencyMode: true, maxBufferLength: 10 });
      hlsRef.current = hls;
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        setHudSub('▶ Live');
        v.play().catch(() => undefined);
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
    } else {
      v.src = url;
      v.play().catch(() => fallback());
    }

    if (remember) {
      const last: LastChannel = { streamId: String(ch.stream_id), name: ch.name, catId: activeCatRef.current };
      localStorage.setItem(LAST_KEY, JSON.stringify(last));
    }
  }, [fmt, pass, remember, server, stopPlayback, user]);

  const loadCategory = React.useCallback(async (cat: Category, resetSel = true) => {
    const id = String(cat.category_id);
    activeCatRef.current = id;
    setHudTitle(cat.category_name || 'Channels');

    let list = cacheRef.current.get(id);
    if (!list) {
      const data: any = await jget(apiUrl({ action: 'get_live_streams', category_id: id }));
      list = Array.isArray(data) ? data : [];
      list.sort((a: any, b: any) => String(a.name || '').localeCompare(String(b.name || '')));
      cacheRef.current.set(id, list);
    }

    const q = chQuery.toLowerCase();
    const visible = q ? list.filter((c) => String(c.name || '').toLowerCase().includes(q)) : list;
    setChannels(visible);
    if (resetSel) setSelCh(0);
  }, [apiUrl, chQuery]);

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
          const cIndex = filtered.findIndex((c) => String(c.category_id) === String(cat.category_id));
          setSelCat(clamp(cIndex, 0, filtered.length - 1));

          const list = cacheRef.current.get(String(cat.category_id)) || [];
          const idx = list.findIndex((c) => String(c.stream_id) === String(last.streamId));
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
    } catch (e: any) {
      setMsg(`Failed: ${e?.message || String(e)}`);
      setSettingsOpen(true);
    } finally {
      setConnecting(false);
    }
  }, [apiUrl, fmt, loadCategory, pass, playChannel, remember, server, user]);

  React.useEffect(() => {
    const saved: any = JSON.parse(localStorage.getItem(SAVE_KEY) || '{}');
    if (saved.server) setServer(saved.server);
    if (saved.user) setUser(saved.user);
    if (saved.pass) setPass(saved.pass);
    if (saved.fmt) setFmt(saved.fmt);
    if (saved.rememberChannel !== undefined) setRemember(saved.rememberChannel !== false);

    if (saved.server && saved.user && saved.pass) {
      setTimeout(() => connect(), 20);
    } else {
      setSettingsOpen(true);
    }

    return () => stopPlayback();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  React.useEffect(() => {
    const next = catQuery.trim().toLowerCase();
    const filtered = next ? allCategories.filter((c) => String(c.category_name || '').toLowerCase().includes(next)) : allCategories;
    setCategories(filtered);
    setSelCat(0);
  }, [allCategories, catQuery]);

  React.useEffect(() => {
    const current = categories[selCat];
    if (current) loadCategory(current, false);
  }, [chQuery]);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (settingsOpen) {
        if (e.key === 'Escape') setSettingsOpen(false);
        return;
      }

      if (!sidebarOpen) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSidebarOpen(true); }
        if (e.key === 'ArrowUp') {
          const n = clamp(selCh - 1, 0, Math.max(0, channels.length - 1));
          setSelCh(n);
          if (channels[n]) playChannel(channels[n]);
        }
        if (e.key === 'ArrowDown') {
          const n = clamp(selCh + 1, 0, Math.max(0, channels.length - 1));
          setSelCh(n);
          if (channels[n]) playChannel(channels[n]);
        }
        return;
      }

      if (e.key === 'Escape' || e.key === 'Backspace') return setSidebarOpen(false);
      if (e.key === 'ArrowUp') return setSelCh((v) => clamp(v - 1, 0, Math.max(0, channels.length - 1)));
      if (e.key === 'ArrowDown') return setSelCh((v) => clamp(v + 1, 0, Math.max(0, channels.length - 1)));
      if ((e.key === 'Enter' || e.key === ' ') && channels[selCh]) {
        playChannel(channels[selCh]);
        setSidebarOpen(false);
      }
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [channels, playChannel, selCh, settingsOpen, sidebarOpen]);

  return (
    <>
      <div id="videoLayer"><video id="video" ref={videoRef} autoPlay playsInline /></div>

      <div id="resumeBadge" className={resumeLabel ? 'show' : ''}>{resumeLabel}</div>

      <div id="backdrop" className={sidebarOpen ? 'open' : ''} onClick={() => setSidebarOpen(false)} />

      <Sidebar
        open={sidebarOpen}
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
        }}
        onPickChannel={(i) => {
          setSelCh(i);
          if (channels[i]) {
            playChannel(channels[i]);
            setSidebarOpen(false);
          }
        }}
      />

      <Hud title={hudTitle} subtitle={hudSub} hidden={settingsOpen} onOpenSettings={() => setSettingsOpen(true)} epg={null} />

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
