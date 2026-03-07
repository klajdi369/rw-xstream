import React from 'react';
import { Hud } from './components/Hud';
import { OrderPrompt } from './components/OrderPrompt';
import { SettingsOverlay } from './components/SettingsOverlay';
import { Sidebar } from './components/Sidebar';
import { useChannelOrder } from './hooks/useChannelOrder';
import { useEpg } from './hooks/useEpg';
import { useHud } from './hooks/useHud';
import { useKeyIndicator } from './hooks/useKeyIndicator';
import { usePlayback } from './hooks/usePlayback';
import { useProxyMemory } from './hooks/useProxyMemory';
import { useToast } from './hooks/useToast';
import { Category, Channel, LastChannel } from './types/player';
import {
  CATEGORY_UNLOCK_PRESS_COUNT,
  CATEGORY_UNLOCK_WINDOW_MS,
  CHANNEL_ROW_JUMP,
  HIDE_CATEGORIES,
  LAST_KEY,
  SAVE_KEY,
} from './constants';
import { clamp, normServer } from './utils';

export default function App() {
  const videoRef = React.useRef<HTMLVideoElement>(null);
  const activeCatRef = React.useRef<string>('');
  const backendBaseRef = React.useRef(
    import.meta.env.DEV
      ? `${window.location.protocol}//${window.location.hostname}:3005`
      : window.location.origin,
  );

  // ── Overlays ────────────────────────────────────────────────────────────────
  const [sidebarOpen, setSidebarOpen] = React.useState(false);
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const [focus, setFocus] = React.useState<'categories' | 'channels'>('channels');

  // ── Connection credentials ───────────────────────────────────────────────────
  const [server, setServer] = React.useState('http://line.tivi-ott.net');
  const [user, setUser] = React.useState('UMYLEJ');
  const [pass, setPass] = React.useState('VFCED1');
  const [fmt, setFmt] = React.useState('m3u8');
  const [remember, setRemember] = React.useState(true);
  const [useProxy, setUseProxy] = React.useState(true);
  const [rememberProxyMode, setRememberProxyMode] = React.useState(true);

  // ── Settings form state ──────────────────────────────────────────────────────
  const [msg, setMsg] = React.useState('');
  const [msgIsError, setMsgIsError] = React.useState(false);
  const [settingsProgress, setSettingsProgress] = React.useState(0);
  const [resumeLabel, setResumeLabel] = React.useState('');

  // ── Connecting overlay ───────────────────────────────────────────────────────
  const [connecting, setConnecting] = React.useState(false);
  const [connectMsg, setConnectMsg] = React.useState('Connecting…');
  const [connectProgress, setConnectProgress] = React.useState(0);

  // ── Categories / channels ────────────────────────────────────────────────────
  const [allCategories, setAllCategories] = React.useState<Category[]>([]);
  const [categories, setCategories] = React.useState<Category[]>([]);
  const [channels, setChannels] = React.useState<Channel[]>([]);
  const [activeCatName, setActiveCatName] = React.useState('Channels');
  const [showAllCategories, setShowAllCategories] = React.useState(false);
  const [selCat, setSelCat] = React.useState(0);
  const [selCh, setSelCh] = React.useState(0);
  const [catQuery, setCatQuery] = React.useState('');
  const [chQuery, setChQuery] = React.useState('');

  // ── Order prompt ─────────────────────────────────────────────────────────────
  const [orderPromptOpen, setOrderPromptOpen] = React.useState(false);
  const [orderPromptDigits, setOrderPromptDigits] = React.useState('');
  const [orderPromptReplaceOnDigit, setOrderPromptReplaceOnDigit] = React.useState(false);
  const [orderPromptTarget, setOrderPromptTarget] = React.useState<{ streamId: string; name: string; catId: string } | null>(null);
  const [orderPromptError, setOrderPromptError] = React.useState('');

  // ── Number zap ───────────────────────────────────────────────────────────────
  const [zapDigits, setZapDigits] = React.useState('');
  const zapTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const orderKeySeqRef = React.useRef<{ count: number; until: number }>({ count: 0, until: 0 });

  // ── Composition cache ─────────────────────────────────────────────────────────
  const cacheRef = React.useRef<Map<string, Channel[]>>(new Map());

  // ── Custom hooks ──────────────────────────────────────────────────────────────
  const { hudTitle, setHudTitle, hudSub, setHudSub, hudHidden, wakeHud } = useHud({ sidebarOpen, settingsOpen });
  const { channelToast, showToast } = useToast();
  const { keyIndicator, showKeyIndicator } = useKeyIndicator();
  const {
    channelOrderMap,
    customOrderInList,
    readChannelOrderMap,
    writeChannelOrderMap,
    readChannelOrderMode,
    writeChannelOrderMode,
    sortWithCustomOrder,
    init: initChannelOrder,
  } = useChannelOrder();
  const { readChannelProxyMemory, writeChannelProxyMemory } = useProxyMemory();

  // ── API helpers ───────────────────────────────────────────────────────────────
  const apiUrl = React.useCallback((params: Record<string, string>) => {
    const u = new URL(`${normServer(server)}/player_api.php`);
    u.searchParams.set('username', user);
    u.searchParams.set('password', pass);
    Object.entries(params).forEach(([k, v]) => u.searchParams.set(k, String(v)));
    return u.toString();
  }, [server, user, pass]);

  const jget = React.useCallback(async (url: string): Promise<unknown> => {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }, []);

  // ── EPG ───────────────────────────────────────────────────────────────────────
  const { epg, fetchEpg, clearEpg, stopEpgRefresh } = useEpg({ apiUrl, jget });

  // ── Playback ──────────────────────────────────────────────────────────────────
  const { playingId, buffering, playChannel, stopPlayback } = usePlayback({
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
  });

  // ── Derived channel lists ─────────────────────────────────────────────────────
  const customOrderedChannels = React.useMemo(
    () => sortWithCustomOrder(channels, activeCatRef.current || '', true),
    [channels, sortWithCustomOrder],
  );
  const channelList = React.useMemo(
    () => sortWithCustomOrder(channels, activeCatRef.current || '', customOrderInList),
    [channels, customOrderInList, sortWithCustomOrder],
  );

  // ── Load a category ───────────────────────────────────────────────────────────
  const loadCategory = React.useCallback(async (cat: Category, resetSel = true) => {
    const id = String(cat.category_id);
    activeCatRef.current = id;
    setActiveCatName(cat.category_name || 'Channels');

    let list = cacheRef.current.get(id);
    if (!list) {
      const data = await jget(apiUrl({ action: 'get_live_streams', category_id: id }));
      list = Array.isArray(data) ? (data as Channel[]) : [];
      list.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
      cacheRef.current.set(id, list);
    }

    const q = chQuery.trim().toLowerCase();
    const visible = q ? list.filter((c) => String(c.name || '').toLowerCase().includes(q)) : list;
    setChannels(visible);
    if (resetSel) setSelCh(0);

    setHudTitle(cat.category_name || 'Channels');
    setHudSub(`${visible.length} channels`);
    wakeHud();
  }, [apiUrl, chQuery, jget, setHudSub, setHudTitle, wakeHud]);

  // ── Connect ───────────────────────────────────────────────────────────────────
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

      const auth = await jget(apiUrl({})) as Record<string, unknown>;
      if (!(auth?.user_info as Record<string, unknown>)?.auth) throw new Error('Auth failed');

      setConnectMsg('Loading categories…');
      setConnectProgress(45);
      setSettingsProgress(45);

      const raw = await jget(apiUrl({ action: 'get_live_categories' }));
      const all = (Array.isArray(raw) ? raw : []) as Category[];
      all.sort((a, b) => Number(a.category_id) - Number(b.category_id));
      const filtered = all.filter((c) => String(c.category_name || '').toUpperCase().includes('ALBANIA'));
      const scopedCategories = HIDE_CATEGORIES ? filtered.slice(0, 1) : filtered;

      setAllCategories(filtered);
      setCategories(HIDE_CATEGORIES && !showAllCategories ? scopedCategories : filtered);
      setSelCat(0);
      setChQuery('');
      cacheRef.current.clear();

      localStorage.setItem(SAVE_KEY, JSON.stringify({
        server, user, pass, fmt,
        rememberChannel: remember,
        useProxy,
        rememberProxyMode,
      }));

      setConnectMsg('Loading channels…');
      setConnectProgress(70);
      setSettingsProgress(70);

      if (scopedCategories[0]) await loadCategory(scopedCategories[0], true);

      setConnectProgress(90);
      setSettingsProgress(90);

      const last: LastChannel | null = JSON.parse(localStorage.getItem(LAST_KEY) || 'null');
      if (last && remember) {
        const cat = scopedCategories.find((c) => String(c.category_id) === String(last.catId)) || scopedCategories[0];
        if (cat) {
          await loadCategory(cat, false);
          const list = cacheRef.current.get(String(cat.category_id)) || [];
          const idx = list.findIndex((c) => String(c.stream_id) === String(last.streamId));
          const catIdx = scopedCategories.findIndex((c) => String(c.category_id) === String(cat.category_id));
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
      const visibleCount = HIDE_CATEGORIES && !showAllCategories ? scopedCategories.length : filtered.length;
      setMsg(`Connected! ${visibleCount} categories.`);
      setMsgIsError(false);
      setHudTitle('Ready');
      setHudSub('OK to open channel list');
      wakeHud();
    } catch (e: unknown) {
      const errMsg = `Failed: ${(e as Error)?.message || String(e)}`;
      setMsg(errMsg);
      setMsgIsError(true);
      setSettingsProgress(0);
      setSettingsOpen(true);
    } finally {
      setConnecting(false);
      setConnectProgress(0);
    }
  }, [apiUrl, fmt, jget, loadCategory, pass, playChannel, remember, rememberProxyMode, server, setHudSub, setHudTitle, showAllCategories, useProxy, user, wakeHud]);

  // ── Init from localStorage ────────────────────────────────────────────────────
  React.useEffect(() => {
    const saved = JSON.parse(localStorage.getItem(SAVE_KEY) || '{}') as Record<string, unknown>;
    if (saved.server) setServer(String(saved.server));
    if (saved.user) setUser(String(saved.user));
    if (saved.pass) setPass(String(saved.pass));
    if (saved.fmt) setFmt(String(saved.fmt));
    if (saved.rememberChannel !== undefined) setRemember(saved.rememberChannel !== false);
    if (saved.useProxy !== undefined) setUseProxy(saved.useProxy !== false);
    if (saved.rememberProxyMode !== undefined) setRememberProxyMode(saved.rememberProxyMode !== false);

    if (saved.server && saved.user && saved.pass) setTimeout(() => connect(), 30);
    else setSettingsOpen(true);

    initChannelOrder();

    return () => {
      stopPlayback();
      if (zapTimerRef.current) clearTimeout(zapTimerRef.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Category filter ───────────────────────────────────────────────────────────
  React.useEffect(() => {
    if (HIDE_CATEGORIES && !showAllCategories) {
      setCategories(allCategories.slice(0, 1));
      setSelCat(0);
      return;
    }
    const q = catQuery.trim().toLowerCase();
    const filtered = q ? allCategories.filter((c) => String(c.category_name || '').toLowerCase().includes(q)) : allCategories;
    setCategories(filtered);
    setSelCat(0);
  }, [allCategories, catQuery, showAllCategories]);

  // ── Channel filter on query change ────────────────────────────────────────────
  React.useEffect(() => {
    const cat = categories[selCat];
    if (!cat) return;
    loadCategory(cat, false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chQuery]);

  // ── Number-zap: jump to channel by typed number ───────────────────────────────
  const executeZap = React.useCallback((digits: string) => {
    const num = parseInt(digits, 10);
    if (isNaN(num) || num < 1 || !customOrderedChannels.length) return;
    const idx = clamp(num - 1, 0, customOrderedChannels.length - 1);
    setSelCh(idx);
    const ch = customOrderedChannels[idx];
    if (ch) {
      playChannel(ch);
      showToast(ch.name || `Channel ${num}`);
    }
  }, [customOrderedChannels, playChannel, showToast]);

  const moveByChannelRow = React.useCallback((dir: 1 | -1) => {
    const navChannels = sidebarOpen && focus === 'channels' ? channelList : customOrderedChannels;
    const step = CHANNEL_ROW_JUMP * dir;
    const n = clamp(selCh + step, 0, Math.max(0, navChannels.length - 1));
    setSelCh(n);
    if (navChannels[n]) {
      playChannel(navChannels[n]);
      showToast(navChannels[n].name || 'Channel');
    }
  }, [channelList, customOrderedChannels, focus, playChannel, selCh, showToast, sidebarOpen]);

  // ── Keyboard handler ──────────────────────────────────────────────────────────
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      showKeyIndicator(e.key);
      const isOrderButton = ['ColorF3Blue', 'Blue', 'NumLock'].includes(e.key);

      // ── Order prompt mode ──
      if (orderPromptOpen) {
        if (e.key >= '0' && e.key <= '9') {
          e.preventDefault();
          setOrderPromptDigits((v) => (orderPromptReplaceOnDigit ? e.key : (v + e.key).slice(0, 4)));
          setOrderPromptReplaceOnDigit(false);
          if (orderPromptError) setOrderPromptError('');
          return;
        }
        if (e.key === 'Backspace') {
          e.preventDefault();
          if (orderPromptReplaceOnDigit) {
            setOrderPromptDigits('');
            setOrderPromptReplaceOnDigit(false);
            if (orderPromptError) setOrderPromptError('');
          } else {
            setOrderPromptDigits((v) => v.slice(0, -1));
            if (orderPromptError) setOrderPromptError('');
          }
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          setOrderPromptOpen(false);
          setOrderPromptDigits('');
          setOrderPromptReplaceOnDigit(false);
          setOrderPromptTarget(null);
          setOrderPromptError('');
          return;
        }
        if (e.key === 'Enter') {
          e.preventDefault();
          const order = parseInt(orderPromptDigits, 10);
          if (!isNaN(order) && order > 0 && orderPromptTarget) {
            const catId = orderPromptTarget.catId || activeCatRef.current || '';
            const catOrders = channelOrderMap[catId] || {};
            const duplicateEntry = Object.entries(catOrders).find(([streamId, pos]) => (
              String(streamId) !== orderPromptTarget.streamId && Number(pos) === order
            ));
            if (duplicateEntry) {
              setOrderPromptError('Enter another number');
              return;
            }
            const next = { ...channelOrderMap };
            next[catId] = { ...(next[catId] || {}), [orderPromptTarget.streamId]: order };
            writeChannelOrderMap(next);
            setHudSub(`Set ${orderPromptTarget.name} to order #${order}`);
            wakeHud();
          }
          setOrderPromptOpen(false);
          setOrderPromptDigits('');
          setOrderPromptReplaceOnDigit(false);
          setOrderPromptTarget(null);
          setOrderPromptError('');
          return;
        }
      }

      // ── Settings open ──
      if (settingsOpen) {
        if (e.key === 'Escape' || e.key === 'Backspace') setSettingsOpen(false);
        if (e.key === 'Enter') connect();
        return;
      }

      // ── Number zap (sidebar closed) ──
      if (!sidebarOpen && e.key >= '0' && e.key <= '9') {
        e.preventDefault();
        const newDigits = zapDigits + e.key;
        setZapDigits(newDigits);
        if (zapTimerRef.current) clearTimeout(zapTimerRef.current);
        zapTimerRef.current = setTimeout(() => {
          executeZap(newDigits);
          setZapDigits('');
        }, 3000);
        wakeHud();
        return;
      }

      wakeHud();

      // ── Order button ──
      if (isOrderButton) {
        e.preventDefault();

        if (HIDE_CATEGORIES && sidebarOpen && !settingsOpen && !orderPromptOpen) {
          const now = Date.now();
          const seq = orderKeySeqRef.current;
          const nextCount = now <= seq.until ? seq.count + 1 : 1;
          orderKeySeqRef.current = { count: nextCount, until: now + CATEGORY_UNLOCK_WINDOW_MS };

          if (nextCount >= CATEGORY_UNLOCK_PRESS_COUNT) {
            orderKeySeqRef.current = { count: 0, until: 0 };
            const unlocking = !showAllCategories;
            setShowAllCategories(unlocking);
            setHudSub(unlocking ? 'Category list unlocked' : 'Category list hidden');
            if (unlocking) {
              setFocus('categories');
            } else {
              setFocus('channels');
              setSelCat(0);
            }
            wakeHud();
            return;
          }
        }

        if (sidebarOpen && focus === 'channels') {
          const next = !customOrderInList;
          writeChannelOrderMode(next);
          setHudSub(next ? 'Channel list: custom order' : 'Channel list: default order');
          return;
        }

        const target = (sidebarOpen ? channelList[selCh] : null)
          || channels.find((c) => String(c.stream_id) === playingId)
          || customOrderedChannels[selCh]
          || customOrderedChannels[0];

        if (target) {
          const catId = activeCatRef.current || '';
          const prevOrder = channelOrderMap[catId]?.[String(target.stream_id)];
          setOrderPromptTarget({
            streamId: String(target.stream_id),
            name: target.name || 'Channel',
            catId,
          });
          setOrderPromptDigits(prevOrder ? String(prevOrder) : '');
          setOrderPromptReplaceOnDigit(Boolean(prevOrder));
          setOrderPromptError('');
          setOrderPromptOpen(true);
        }
        return;
      }

      // ── Sidebar closed navigation ──
      if (!sidebarOpen) {
        if (['PageUp', 'ChannelUp', 'MediaTrackPrevious'].includes(e.key)) {
          e.preventDefault();
          moveByChannelRow(-1);
          return;
        }
        if (['PageDown', 'ChannelDown', 'MediaTrackNext'].includes(e.key)) {
          e.preventDefault();
          moveByChannelRow(1);
          return;
        }
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          if (playingId && customOrderedChannels.length) {
            const playIdx = customOrderedChannels.findIndex((c) => String(c.stream_id) === playingId);
            if (playIdx >= 0) setSelCh(playIdx);
          }
          setSidebarOpen(true);
          setFocus('channels');
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          const n = clamp(selCh - 1, 0, Math.max(0, customOrderedChannels.length - 1));
          setSelCh(n);
          if (customOrderedChannels[n]) {
            playChannel(customOrderedChannels[n]);
            showToast(customOrderedChannels[n].name || 'Channel');
          }
          return;
        }
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          const n = clamp(selCh + 1, 0, Math.max(0, customOrderedChannels.length - 1));
          setSelCh(n);
          if (customOrderedChannels[n]) {
            playChannel(customOrderedChannels[n]);
            showToast(customOrderedChannels[n].name || 'Channel');
          }
        }
        return;
      }

      // ── Sidebar open navigation ──
      if (e.key === 'Escape' || e.key === 'Backspace') {
        e.preventDefault();
        if (!HIDE_CATEGORIES && focus === 'categories') setFocus('channels');
        else setSidebarOpen(false);
        return;
      }

      if (!HIDE_CATEGORIES && e.key === 'ArrowLeft' && focus === 'channels') {
        e.preventDefault();
        setFocus('categories');
        return;
      }
      if (!HIDE_CATEGORIES && e.key === 'ArrowRight' && focus === 'categories') {
        e.preventDefault();
        setFocus('channels');
        return;
      }

      if (['PageUp', 'ChannelUp', 'MediaTrackPrevious'].includes(e.key)) {
        e.preventDefault();
        if (focus === 'categories') {
          setSelCat((v) => clamp(v - CHANNEL_ROW_JUMP, 0, Math.max(0, categories.length - 1)));
        } else {
          setSelCh((v) => clamp(v - CHANNEL_ROW_JUMP, 0, Math.max(0, channels.length - 1)));
        }
      }
      if (['PageDown', 'ChannelDown', 'MediaTrackNext'].includes(e.key)) {
        e.preventDefault();
        if (focus === 'categories') {
          setSelCat((v) => clamp(v + CHANNEL_ROW_JUMP, 0, Math.max(0, categories.length - 1)));
        } else {
          setSelCh((v) => clamp(v + CHANNEL_ROW_JUMP, 0, Math.max(0, channels.length - 1)));
        }
      }

      if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (focus === 'categories') {
          setSelCat((v) => clamp(v - 1, 0, Math.max(0, categories.length - 1)));
        } else {
          setSelCh((v) => clamp(v - 1, 0, Math.max(0, channelList.length - 1)));
        }
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (focus === 'categories') {
          setSelCat((v) => clamp(v + 1, 0, Math.max(0, categories.length - 1)));
        } else {
          setSelCh((v) => clamp(v + 1, 0, Math.max(0, channelList.length - 1)));
        }
      }
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (focus === 'categories') {
          const cat = categories[selCat];
          if (cat) loadCategory(cat, true);
          setFocus('channels');
        } else if (channelList[selCh]) {
          playChannel(channelList[selCh]);
          setSidebarOpen(false);
        }
      }
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [
    categories, channelList, channelOrderMap, channels, connect, customOrderInList,
    customOrderedChannels, executeZap, focus, loadCategory, moveByChannelRow,
    orderPromptDigits, orderPromptError, orderPromptOpen, orderPromptReplaceOnDigit,
    orderPromptTarget, playChannel, playingId, selCat, selCh, settingsOpen,
    showAllCategories, showKeyIndicator, showToast, sidebarOpen, wakeHud,
    writeChannelOrderMap, writeChannelOrderMode, setHudSub, zapDigits,
  ]);

  // ── Render ────────────────────────────────────────────────────────────────────
  return (
    <>
      <div id="videoLayer"><video id="video" ref={videoRef} autoPlay playsInline /></div>

      <div id="bufferOverlay" className={buffering ? 'show' : ''}>
        <div className="bufferSpin" />
      </div>

      <div id="resumeBadge" className={resumeLabel ? 'show' : ''}>{resumeLabel}</div>

      <div id="channelToast" className={channelToast ? 'show' : ''}>{channelToast}</div>

      <div id="zapOverlay" className={zapDigits ? 'show' : ''}>
        {zapDigits}
        <div className="zapSub">channel</div>
      </div>

      <div id="backdrop" className={sidebarOpen ? 'open' : ''} onClick={() => setSidebarOpen(false)} />

      <Sidebar
        open={sidebarOpen}
        focus={focus}
        categories={categories}
        showCategories={!HIDE_CATEGORIES || showAllCategories}
        channels={channelList}
        selectedCategory={selCat}
        selectedChannel={selCh}
        categoryQuery={catQuery}
        channelQuery={chQuery}
        playingId={playingId}
        activeCategoryName={activeCatName}
        channelOrderModeLabel={customOrderInList ? 'Custom' : 'Default'}
        onCategoryQuery={(value) => { if (!HIDE_CATEGORIES || showAllCategories) setCatQuery(value); }}
        onChannelQuery={setChQuery}
        onPickCategory={async (i) => {
          if (HIDE_CATEGORIES && !showAllCategories) return;
          setSelCat(i);
          const cat = categories[i];
          if (cat) await loadCategory(cat, true);
          setFocus('channels');
        }}
        onPickChannel={(i) => {
          setSelCh(i);
          if (channelList[i]) {
            playChannel(channelList[i]);
            setSidebarOpen(false);
          }
        }}
      />

      <OrderPrompt
        open={orderPromptOpen}
        digits={orderPromptDigits}
        target={orderPromptTarget}
        error={orderPromptError}
      />

      <Hud
        title={hudTitle}
        subtitle={hudSub}
        hidden={hudHidden || settingsOpen}
        onOpenSettings={() => setSettingsOpen(true)}
        keyIndicator={keyIndicator}
        epg={epg}
      />

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
