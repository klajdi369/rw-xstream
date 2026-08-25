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

  // Read persisted settings once, synchronously, so the very first render already
  // holds the saved values. Seeding state from these (instead of patching them in
  // later via an effect) is what keeps startup auto-connect from running with —
  // and then re-saving — the hardcoded defaults, which used to clobber the URL a
  // user had saved.
  const savedSettingsRef = React.useRef<Record<string, unknown> | null>(null);
  if (savedSettingsRef.current === null) {
    try {
      const parsed = JSON.parse(localStorage.getItem(SAVE_KEY) || '{}');
      savedSettingsRef.current = parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      savedSettingsRef.current = {};
    }
  }
  const saved = savedSettingsRef.current ?? {};

  // ── Overlays ────────────────────────────────────────────────────────────────
  const [sidebarOpen, setSidebarOpen] = React.useState(false);
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const [focus, setFocus] = React.useState<'categories' | 'channels'>('channels');

  // ── Connection credentials ───────────────────────────────────────────────────
  const [server, setServer] = React.useState(saved.server ? String(saved.server) : 'http://cgi26817.wd.business-cdn-8k.com');
  const [user, setUser] = React.useState(saved.user ? String(saved.user) : '2ac2f1121896');
  const [pass, setPass] = React.useState(saved.pass ? String(saved.pass) : '6b68a4da31');
  const [fmt, setFmt] = React.useState(saved.fmt ? String(saved.fmt) : 'm3u8');
  const [remember, setRemember] = React.useState(saved.rememberChannel !== false);
  const [useProxy, setUseProxy] = React.useState(saved.useProxy !== false);
  const [rememberProxyMode, setRememberProxyMode] = React.useState(saved.rememberProxyMode !== false);

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

  // ── Channel-surf tuning debounce ───────────────────────────────────────────────
  // On a TV remote arrow presses repeat and come in bursts. Tuning on every
  // keystroke fired a storm of playback attempts and made scrolling stutter.
  // Debounce the actual tune so the highlight + toast update instantly while
  // playback only starts once the user pauses on a channel.
  const tuneTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Composition cache ─────────────────────────────────────────────────────────
  const cacheRef = React.useRef<Map<string, Channel[]>>(new Map());

  // Sidebar search inputs — so ↑ at the top of a list can step up into search.
  const catSearchRef = React.useRef<HTMLInputElement>(null);
  const chSearchRef = React.useRef<HTMLInputElement>(null);

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
    // Fetch the Server URL (player_api.php) straight from the client first.
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (directErr) {
      // A direct client fetch of the Server URL can fail for CORS, TLS/mixed
      // content, DNS, or transient network reasons. When it does, route just
      // this one API request through our own server's proxy and try again.
      // This fallback is scoped to the Server URL only — streams and every
      // other request keep their existing behaviour (nothing new is proxied).
      try {
        const proxied = `${backendBaseRef.current}/proxy?url=${encodeURIComponent(url)}&deint=0`;
        const r = await fetch(proxied, { cache: 'no-store' });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return await r.json();
      } catch {
        // Surface the original client-side failure — it's the more meaningful
        // one to show the user when even the proxy fallback couldn't recover.
        throw directErr;
      }
    }
  }, []);

  // ── EPG ───────────────────────────────────────────────────────────────────────
  const { epg, fetchEpg, clearEpg, stopEpgRefresh } = useEpg({
    apiUrl,
    jget,
    backendBaseUrl: backendBaseRef.current,
  });

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

  // ── Derived channel list ──────────────────────────────────────────────────────
  // A single ordered list drives both the on-screen sidebar and the off-screen
  // (sidebar-closed) arrow/zap navigation, so `selCh` always indexes the same
  // thing — the highlight can't drift onto a different channel between modes.
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
      try {
        const data = await jget(apiUrl({ action: 'get_live_streams', category_id: id }));
        list = Array.isArray(data) ? (data as Channel[]) : [];
        list.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
        cacheRef.current.set(id, list);
      } catch (e) {
        // Don't leave the failure as an unhandled rejection — tell the user the
        // channel list couldn't load (the Server URL was unreachable even via
        // the proxy fallback) instead of silently showing nothing.
        setChannels([]);
        setHudTitle(cat.category_name || 'Channels');
        setHudSub(`Failed to load channels — ${(e as Error)?.message || 'connection error'}`);
        wakeHud();
        return;
      }
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
    // Credentials were already seeded into state from `saved` above, so the
    // first-render `connect` closure captured here holds the saved values (not
    // the hardcoded defaults) — auto-connect and its localStorage write are
    // therefore consistent with what the user saved.

    // Store the timer so StrictMode's double-invoked effect (dev) can cancel
    // the first run's pending connect() and we don't fire duplicate auth/EPG
    // fetches.
    let connectTimer: ReturnType<typeof setTimeout> | undefined;
    if (saved.server && saved.user && saved.pass) connectTimer = setTimeout(() => connect(), 30);
    else setSettingsOpen(true);

    initChannelOrder();

    return () => {
      if (connectTimer) clearTimeout(connectTimer);
      stopPlayback();
      if (zapTimerRef.current) clearTimeout(zapTimerRef.current);
      if (tuneTimerRef.current) clearTimeout(tuneTimerRef.current);
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

  // ── Debounced tuning helpers ───────────────────────────────────────────────────
  const cancelPendingTune = React.useCallback(() => {
    if (tuneTimerRef.current) {
      clearTimeout(tuneTimerRef.current);
      tuneTimerRef.current = null;
    }
  }, []);

  // Update the highlight/toast now, but defer the heavy playback start until the
  // arrow presses settle — so surfing through channels stays smooth on a TV.
  const tuneChannel = React.useCallback((ch: Channel | undefined) => {
    if (!ch) return;
    showToast(ch.name || 'Channel');
    wakeHud();
    cancelPendingTune();
    tuneTimerRef.current = setTimeout(() => {
      tuneTimerRef.current = null;
      playChannel(ch);
    }, 280);
  }, [cancelPendingTune, playChannel, showToast, wakeHud]);

  // Play right away and drop any queued debounce (explicit selections, zaps).
  const playNow = React.useCallback((ch: Channel | undefined) => {
    if (!ch) return;
    cancelPendingTune();
    playChannel(ch);
  }, [cancelPendingTune, playChannel]);

  // Arrow keys pressed while a sidebar search field is focused. The field blurs
  // itself first; here we just apply the resulting navigation so you can leave
  // the search box — and switch panels — without getting stuck typing.
  const onSidebarSearchNav = React.useCallback((dir: 'up' | 'down' | 'left' | 'right') => {
    const categoriesVisible = !HIDE_CATEGORIES || showAllCategories;
    if (dir === 'left' && categoriesVisible) setFocus('categories');
    else if (dir === 'right' && categoriesVisible) setFocus('channels');
    // up / down simply return control to the list; its highlight is already set.
  }, [showAllCategories]);

  // ── Number-zap: jump to channel by typed number ───────────────────────────────
  const executeZap = React.useCallback((digits: string) => {
    const num = parseInt(digits, 10);
    if (isNaN(num) || num < 1 || !channelList.length) return;
    const idx = clamp(num - 1, 0, channelList.length - 1);
    setSelCh(idx);
    const ch = channelList[idx];
    if (ch) {
      playNow(ch);
      showToast(ch.name || `Channel ${num}`);
    }
  }, [channelList, playNow, showToast]);

  const moveByChannelRow = React.useCallback((dir: 1 | -1) => {
    const step = CHANNEL_ROW_JUMP * dir;
    const n = clamp(selCh + step, 0, Math.max(0, channelList.length - 1));
    setSelCh(n);
    tuneChannel(channelList[n]);
  }, [channelList, selCh, tuneChannel]);

  // ── Keyboard handler ──────────────────────────────────────────────────────────
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Don't hijack keys destined for a focused text field (the sidebar search
      // boxes) — arrows must move the caret and Escape must belong to the input,
      // not navigate the channel list or close the sidebar.
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) {
        return;
      }

      showKeyIndicator(e.key);
      const isOrderButton = ['ColorF3Blue', 'Blue', 'Pause'].includes(e.key);

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
        // The order dialog owns the keyboard while it's open — swallow every
        // other key so arrows, Page/Channel keys, or Blue/Pause can't leak
        // through and navigate or reorder the channel list underneath it.
        e.preventDefault();
        return;
      }

      // ── Settings open ──
      // The SettingsOverlay owns its own keyboard navigation while open; the
      // live handler just stays out of the way.
      if (settingsOpen) return;

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
          || channelList[selCh]
          || channelList[0];

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
          if (playingId && channelList.length) {
            const playIdx = channelList.findIndex((c) => String(c.stream_id) === playingId);
            if (playIdx >= 0) setSelCh(playIdx);
          }
          setSidebarOpen(true);
          setFocus('channels');
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          const n = clamp(selCh - 1, 0, Math.max(0, channelList.length - 1));
          setSelCh(n);
          tuneChannel(channelList[n]);
          return;
        }
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          const n = clamp(selCh + 1, 0, Math.max(0, channelList.length - 1));
          setSelCh(n);
          tuneChannel(channelList[n]);
        }
        return;
      }

      // ── Sidebar open navigation ──
      // Categories can be switched to whenever they're actually on screen —
      // either always-shown, or unlocked via the category-unlock sequence.
      const categoriesVisible = !HIDE_CATEGORIES || showAllCategories;

      if (e.key === 'Escape' || e.key === 'Backspace') {
        e.preventDefault();
        if (categoriesVisible && focus === 'categories') setFocus('channels');
        else setSidebarOpen(false);
        return;
      }

      // '/' jumps straight to the focused panel's search box.
      if (e.key === '/') {
        e.preventDefault();
        (focus === 'categories' ? catSearchRef : chSearchRef).current?.focus();
        return;
      }

      if (categoriesVisible && e.key === 'ArrowLeft' && focus === 'channels') {
        e.preventDefault();
        setFocus('categories');
        return;
      }
      if (categoriesVisible && e.key === 'ArrowRight' && focus === 'categories') {
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
          // At the top of the list, step up into the search box.
          if (selCat === 0) catSearchRef.current?.focus();
          else setSelCat((v) => clamp(v - 1, 0, Math.max(0, categories.length - 1)));
        } else if (selCh === 0) {
          chSearchRef.current?.focus();
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
          playNow(channelList[selCh]);
          setSidebarOpen(false);
        }
      }
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [
    categories, channelList, channelOrderMap, channels, connect,
    customOrderInList, executeZap, focus, loadCategory, moveByChannelRow,
    orderPromptDigits, orderPromptError, orderPromptOpen, orderPromptReplaceOnDigit,
    orderPromptTarget, playNow, playingId, selCat, selCh, settingsOpen,
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
        categorySearchRef={catSearchRef}
        channelSearchRef={chSearchRef}
        onSearchNav={onSidebarSearchNav}
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
            playNow(channelList[i]);
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
        onClose={() => setSettingsOpen(false)}
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
