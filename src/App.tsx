import React from 'react';
import Hls from 'hls.js';
import mpegts from 'mpegts.js';
import { Hud } from './components/Hud';
import { SettingsOverlay } from './components/SettingsOverlay';
import { Sidebar } from './components/Sidebar';
import { LastPlayed, MediaResult, SeriesEpisode } from './types/player';

const SAVE_KEY = 'xtream_vod_v1';
const LAST_KEY = 'xtream_vod_last_played_v1';

const clamp = (n: number, a: number, b: number) => Math.max(a, Math.min(b, n));

function normServer(s: string) {
  const t = (s || '').trim();
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
  const [connectMsg, setConnectMsg] = React.useState('Connecting…');
  const [connectProgress, setConnectProgress] = React.useState(0);

  const [hudTitle, setHudTitle] = React.useState('VOD Player');
  const [hudSub, setHudSub] = React.useState('Open search and pick a movie or series');
  const [hudHidden, setHudHidden] = React.useState(true);
  const [focus, setFocus] = React.useState<'results' | 'episodes'>('results');

  const [server, setServer] = React.useState('http://line.tivi-ott.net');
  const [user, setUser] = React.useState('UMYLEJ');
  const [pass, setPass] = React.useState('VFCED1');
  const [fmt, setFmt] = React.useState('m3u8');
  const [remember, setRemember] = React.useState(true);
  const [useProxy, setUseProxy] = React.useState(true);
  const [rememberProxyMode, setRememberProxyMode] = React.useState(true);

  const [msg, setMsg] = React.useState('');
  const [msgIsError, setMsgIsError] = React.useState(false);
  const [settingsProgress, setSettingsProgress] = React.useState(0);

  const [query, setQuery] = React.useState('');
  const [allResults, setAllResults] = React.useState<MediaResult[]>([]);
  const [results, setResults] = React.useState<MediaResult[]>([]);
  const [episodes, setEpisodes] = React.useState<SeriesEpisode[]>([]);
  const [selectedResult, setSelectedResult] = React.useState(0);
  const [selectedEpisode, setSelectedEpisode] = React.useState(0);
  const [activeSeriesName, setActiveSeriesName] = React.useState('Episodes');

  const [buffering, setBuffering] = React.useState(false);
  const [playingKey, setPlayingKey] = React.useState<string | null>(null);

  const hudTimerRef = React.useRef<any>(null);
  const playTokenRef = React.useRef(0);
  const seriesEpisodeCacheRef = React.useRef<Map<string, SeriesEpisode[]>>(new Map());
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

  const apiProxyUrl = React.useCallback((params: Record<string, any>) => {
    const direct = apiUrl(params);
    return `${backendBaseRef.current}/proxy?url=${encodeURIComponent(direct)}&deint=0`;
  }, [apiUrl]);

  const jget = React.useCallback(async (url: string): Promise<any> => {
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);

    // Handle very large payloads (10MB+) and providers that send incorrect content-types.
    const text = await r.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new Error('Invalid JSON from provider');
    }
  }, []);

  const wakeHud = React.useCallback(() => {
    setHudHidden(false);
    clearTimeout(hudTimerRef.current);
    if (!sidebarOpen && !settingsOpen) {
      hudTimerRef.current = setTimeout(() => setHudHidden(true), 3000);
    }
  }, [settingsOpen, sidebarOpen]);

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

  const playUrl = React.useCallback((url: string, key: string, title: string, subtitle: string) => {
    const v = videoRef.current;
    if (!v) return;

    const token = ++playTokenRef.current;
    stopPlayback();
    setBuffering(true);
    setHudTitle(title);
    setHudSub(subtitle);
    setPlayingKey(key);
    wakeHud();

    const fallbackNative = () => {
      if (token !== playTokenRef.current) return;
      stopPlayback();
      v.src = url;
      v.oncanplay = () => {
        if (token !== playTokenRef.current) return;
        setBuffering(false);
      };
      v.onerror = () => {
        if (token !== playTokenRef.current) return;
        setBuffering(false);
        setHudSub('Cannot play this item');
      };
      v.play().catch(() => {
        if (token !== playTokenRef.current) return;
        setBuffering(false);
        setHudSub('Playback blocked by browser');
      });
    };

    const isLikelyHls = /\.m3u8($|\?)/i.test(url);
    const isLikelyTs = /\.ts($|\?)/i.test(url);

    if (isLikelyHls && Hls.isSupported()) {
      const hls = new Hls({ lowLatencyMode: false });
      hlsRef.current = hls;
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        if (token !== playTokenRef.current) return;
        v.play().then(() => setBuffering(false)).catch(() => fallbackNative());
      });
      hls.on(Hls.Events.ERROR, (_: any, data: any) => {
        if (token !== playTokenRef.current) return;
        if (data?.fatal) fallbackNative();
      });
      hls.attachMedia(v);
      hls.loadSource(url);
      return;
    }

    if (isLikelyTs && mpegts.getFeatureList().mseLivePlayback) {
      const p = mpegts.createPlayer({ type: 'mpegts', isLive: false, url });
      mtsRef.current = p;
      p.on(mpegts.Events.ERROR, () => fallbackNative());
      p.attachMediaElement(v);
      p.load();
      v.play().then(() => setBuffering(false)).catch(() => fallbackNative());
      return;
    }

    fallbackNative();
  }, [stopPlayback, wakeHud]);

  const playMovie = React.useCallback((id: string, name: string, ext: string) => {
    const movieUrl = `${normServer(server)}/movie/${encodeURIComponent(user)}/${encodeURIComponent(pass)}/${encodeURIComponent(id)}.${encodeURIComponent(ext || 'mp4')}`;
    playUrl(movieUrl, `movie:${id}`, name || 'Movie', '▶ Movie');
    if (remember) {
      const last: LastPlayed = { kind: 'movie', id, name };
      localStorage.setItem(LAST_KEY, JSON.stringify(last));
    }
  }, [pass, playUrl, remember, server, user]);

  const playEpisode = React.useCallback((episode: SeriesEpisode, seriesId: string, seriesName: string) => {
    const epUrl = `${normServer(server)}/series/${encodeURIComponent(user)}/${encodeURIComponent(pass)}/${encodeURIComponent(episode.id)}.${encodeURIComponent(episode.containerExtension || 'mp4')}`;
    playUrl(epUrl, `episode:${episode.id}`, seriesName, `▶ S${episode.season}E${episode.episodeNum} ${episode.title}`);
    if (remember) {
      const last: LastPlayed = {
        kind: 'episode',
        id: episode.id,
        name: episode.title,
        seriesId,
      };
      localStorage.setItem(LAST_KEY, JSON.stringify(last));
    }
  }, [pass, playUrl, remember, server, user]);

  const loadSeriesEpisodes = React.useCallback(async (seriesId: string, seriesName: string) => {
    setActiveSeriesName(seriesName || 'Episodes');

    let cached = seriesEpisodeCacheRef.current.get(seriesId);
    if (!cached) {
      const data = await jget(apiProxyUrl({ action: 'get_series_info', series_id: seriesId }));
      const rawEpisodes = data?.episodes || {};
      const flattened: SeriesEpisode[] = [];

      Object.entries(rawEpisodes).forEach(([seasonKey, value]) => {
        const seasonNum = Number(seasonKey);
        const season = Number.isFinite(seasonNum) && seasonNum > 0 ? seasonNum : 1;
        const list = Array.isArray(value) ? value : [];
        list.forEach((entry: any, i: number) => {
          const info = entry?.info || {};
          const id = String(entry?.id ?? entry?.episode_id ?? info?.movie_id ?? info?.id ?? '');
          if (!id) return;
          const episodeNumRaw = Number(entry?.episode_num ?? entry?.episode_number ?? i + 1);
          flattened.push({
            id,
            title: String(entry?.title ?? info?.title ?? `Episode ${i + 1}`),
            season,
            episodeNum: Number.isFinite(episodeNumRaw) && episodeNumRaw > 0 ? episodeNumRaw : i + 1,
            containerExtension: String(info?.container_extension ?? entry?.container_extension ?? 'mp4'),
            poster: String(info?.movie_image ?? entry?.movie_image ?? ''),
          });
        });
      });

      flattened.sort((a, b) => (a.season - b.season) || (a.episodeNum - b.episodeNum));
      cached = flattened;
      seriesEpisodeCacheRef.current.set(seriesId, flattened);
    }

    setEpisodes(cached);
    setSelectedEpisode(0);
    setHudSub(cached.length ? `Loaded ${cached.length} episodes` : 'No episodes found');
    wakeHud();
  }, [apiProxyUrl, jget, wakeHud]);

  const connect = React.useCallback(async () => {
    if (!server || !user || !pass) {
      setMsg('Fill all fields');
      setMsgIsError(true);
      return;
    }

    try {
      setConnecting(true);
      setConnectMsg('Checking account…');
      setConnectProgress(10);
      setSettingsProgress(10);
      setMsg('Connecting…');
      setMsgIsError(false);

      const auth: any = await jget(apiProxyUrl({}));
      if (!auth?.user_info?.auth) throw new Error('Auth failed');

      setConnectMsg('Loading movies…');
      setConnectProgress(40);
      setSettingsProgress(40);
      const moviesRaw: any = await jget(apiProxyUrl({ action: 'get_vod_streams' }));
      const movies: MediaResult[] = (Array.isArray(moviesRaw) ? moviesRaw : []).map((m: any) => ({
        kind: 'movie' as const,
        id: String(m.stream_id),
        name: String(m.name || 'Untitled movie'),
        containerExtension: String(m.container_extension || 'mp4'),
        poster: String(m.stream_icon || ''),
      }));

      setConnectMsg('Loading series…');
      setConnectProgress(70);
      setSettingsProgress(70);
      const seriesRaw: any = await jget(apiProxyUrl({ action: 'get_series' }));
      const series: MediaResult[] = (Array.isArray(seriesRaw) ? seriesRaw : []).map((s: any) => ({
        kind: 'series' as const,
        id: String(s.series_id),
        name: String(s.name || 'Untitled series'),
        poster: String(s.cover || s.cover_big || ''),
      }));

      const merged = [...movies, ...series].sort((a, b) => a.name.localeCompare(b.name));
      setAllResults(merged);
      setResults(merged);
      setEpisodes([]);
      setSelectedResult(0);
      setSelectedEpisode(0);
      setQuery('');
      seriesEpisodeCacheRef.current.clear();

      localStorage.setItem(SAVE_KEY, JSON.stringify({
        server,
        user,
        pass,
        fmt,
        rememberChannel: remember,
        useProxy,
        rememberProxyMode,
      }));

      const last: LastPlayed | null = JSON.parse(localStorage.getItem(LAST_KEY) || 'null');
      if (remember && last?.kind === 'movie') {
        const movie = merged.find((m) => m.kind === 'movie' && m.id === last.id);
        if (movie && movie.kind === 'movie') playMovie(movie.id, movie.name, movie.containerExtension);
      }

      setConnectProgress(100);
      setSettingsProgress(100);
      setMsg(`Connected! ${movies.length} movies + ${series.length} series.`);
      setMsgIsError(false);
      setSettingsOpen(false);
      setHudTitle('VOD Ready');
      setHudSub('Search and press OK to play');
      wakeHud();
    } catch (e: any) {
      setMsg(`Failed: ${e?.message || String(e)}. Check provider URL/server reachability.`);
      setMsgIsError(true);
      setSettingsOpen(true);
      setSettingsProgress(0);
    } finally {
      setConnecting(false);
      setConnectProgress(0);
    }
  }, [apiProxyUrl, fmt, jget, pass, playMovie, remember, rememberProxyMode, server, useProxy, user, wakeHud]);

  React.useEffect(() => {
    const saved: any = JSON.parse(localStorage.getItem(SAVE_KEY) || '{}');
    if (saved.server) setServer(saved.server);
    if (saved.user) setUser(saved.user);
    if (saved.pass) setPass(saved.pass);
    if (saved.fmt) setFmt(saved.fmt);
    if (saved.rememberChannel !== undefined) setRemember(saved.rememberChannel !== false);
    if (saved.useProxy !== undefined) setUseProxy(saved.useProxy !== false);
    if (saved.rememberProxyMode !== undefined) setRememberProxyMode(saved.rememberProxyMode !== false);

    if (saved.server && saved.user && saved.pass) setTimeout(() => connect(), 20);
    else setSettingsOpen(true);

    return () => {
      stopPlayback();
      clearTimeout(hudTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  React.useEffect(() => {
    const q = query.trim().toLowerCase();
    const filtered = q ? allResults.filter((r) => r.name.toLowerCase().includes(q)) : allResults;
    setResults(filtered);
    setSelectedResult(0);
    if (!q) {
      setEpisodes([]);
      setActiveSeriesName('Episodes');
    }
  }, [allResults, query]);

  React.useEffect(() => {
    clearTimeout(hudTimerRef.current);
    if (!sidebarOpen && !settingsOpen && !hudHidden) {
      hudTimerRef.current = setTimeout(() => setHudHidden(true), 1800);
    }
  }, [hudHidden, settingsOpen, sidebarOpen]);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (settingsOpen) {
        if (e.key === 'Escape' || e.key === 'Backspace') setSettingsOpen(false);
        if (e.key === 'Enter') connect();
        return;
      }

      wakeHud();

      if (!sidebarOpen) {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          setSidebarOpen(true);
          setFocus('results');
          return;
        }
        return;
      }

      if (e.key === 'Escape') {
        e.preventDefault();
        if (focus === 'episodes') setFocus('results');
        else setSidebarOpen(false);
        return;
      }

      if (focus === 'results' && e.key === 'Backspace') {
        e.preventDefault();
        if (query.length > 0) {
          setQuery((v) => v.slice(0, -1));
          return;
        }
        setSidebarOpen(false);
        return;
      }

      if (focus === 'results' && e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
        const ch = e.key;
        if (/^[\w\s\-'.:&]$/u.test(ch)) {
          e.preventDefault();
          setQuery((v) => `${v}${ch}`);
          return;
        }
      }

      if (focus === 'episodes' && e.key === 'Backspace') {
        e.preventDefault();
        setFocus('results');
        return;
      }

      if (e.key === 'ArrowLeft' && focus === 'episodes') {
        e.preventDefault();
        setFocus('results');
        return;
      }
      if (e.key === 'ArrowRight' && focus === 'results' && episodes.length) {
        e.preventDefault();
        setFocus('episodes');
        return;
      }

      if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (focus === 'results') setSelectedResult((v) => clamp(v - 1, 0, Math.max(0, results.length - 1)));
        else setSelectedEpisode((v) => clamp(v - 1, 0, Math.max(0, episodes.length - 1)));
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (focus === 'results') setSelectedResult((v) => clamp(v + 1, 0, Math.max(0, results.length - 1)));
        else setSelectedEpisode((v) => clamp(v + 1, 0, Math.max(0, episodes.length - 1)));
      }
      if (e.key === 'PageUp') {
        e.preventDefault();
        if (focus === 'results') setSelectedResult((v) => clamp(v - 8, 0, Math.max(0, results.length - 1)));
        else setSelectedEpisode((v) => clamp(v - 8, 0, Math.max(0, episodes.length - 1)));
      }
      if (e.key === 'PageDown') {
        e.preventDefault();
        if (focus === 'results') setSelectedResult((v) => clamp(v + 8, 0, Math.max(0, results.length - 1)));
        else setSelectedEpisode((v) => clamp(v + 8, 0, Math.max(0, episodes.length - 1)));
      }

      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (focus === 'results') {
          const item = results[selectedResult];
          if (!item) return;
          if (item.kind === 'movie') {
            playMovie(item.id, item.name, item.containerExtension);
            setSidebarOpen(false);
            return;
          }
          void loadSeriesEpisodes(item.id, item.name);
          setFocus('episodes');
          return;
        }

        const item = results[selectedResult];
        const ep = episodes[selectedEpisode];
        if (!item || item.kind !== 'series' || !ep) return;
        playEpisode(ep, item.id, item.name);
        setSidebarOpen(false);
      }
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [connect, episodes, focus, loadSeriesEpisodes, playEpisode, playMovie, query, results, selectedEpisode, selectedResult, settingsOpen, sidebarOpen, wakeHud]);

  return (
    <>
      <div id="videoLayer"><video id="video" ref={videoRef} autoPlay playsInline controls /></div>

      <div id="bufferOverlay" className={buffering ? 'show' : ''}>
        <div className="bufferSpin" />
      </div>

      <div id="backdrop" className={sidebarOpen ? 'open' : ''} onClick={() => setSidebarOpen(false)} />

      <Sidebar
        open={sidebarOpen}
        focus={focus}
        query={query}
        results={results}
        episodes={episodes}
        selectedResult={selectedResult}
        selectedEpisode={selectedEpisode}
        playingKey={playingKey}
        activeSeriesName={activeSeriesName}
        onQueryChange={setQuery}
        onPickResult={(index) => {
          setSelectedResult(index);
          const item = results[index];
          if (!item) return;
          if (item.kind === 'movie') {
            playMovie(item.id, item.name, item.containerExtension);
            setSidebarOpen(false);
          } else {
            void loadSeriesEpisodes(item.id, item.name);
            setFocus('episodes');
          }
        }}
        onPickEpisode={(index) => {
          setSelectedEpisode(index);
          const item = results[selectedResult];
          const ep = episodes[index];
          if (!item || item.kind !== 'series' || !ep) return;
          playEpisode(ep, item.id, item.name);
          setSidebarOpen(false);
        }}
      />

      <Hud title={hudTitle} subtitle={hudSub} hidden={hudHidden || settingsOpen} onOpenSettings={() => setSettingsOpen(true)} keyIndicator="" epg={null} />

      <SettingsOverlay
        open={settingsOpen}
        server={server}
        user={user}
        pass={pass}
        fmt={fmt}
        remember={remember}
        useProxy={useProxy}
        rememberProxyMode={rememberProxyMode}
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
          if (patch.rememberProxyMode !== undefined) setRememberProxyMode(patch.rememberProxyMode);
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
