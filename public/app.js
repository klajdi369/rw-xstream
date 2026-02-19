(() => {
'use strict';

const ITEM_H = 76;
const OVERSCAN = 5;
const SAVE_KEY = 'xtream_tv_v4';
const LAST_KEY = 'xtream_last_ch';

const S = {
  server: '', user: '', pass: '', fmt: 'm3u8',
  cats: [], catsFiltered: [],
  chCache: new Map(),
  channels: [],
  selCat: 0, selCh: 0,
  focus: 'channels',
  activeCatId: null,
  playingId: null,
  chQ: '', catQ: '',
  hls: null, mts: null,
  currentUrl: null,
  hudTimer: null, hudHideTimer: null,
  sidebarOpen: false, settingsOpen: false,
  rememberChannel: true, connected: false,
  epgTimer: null, epgRefreshTimer: null,
};

const $ = id => document.getElementById(id);
const D = {
  video: $('video'),
  hud: $('hud'), hudTitle: $('hudTitle'), hudSub: $('hudSub'),
  epgBlock: $('epgBlock'), epgNowTitle: $('epgNowTitle'), epgNowTime: $('epgNowTime'),
  epgBarFill: $('epgBarFill'), epgNext: $('epgNext'),
  settingsBtn: $('settingsBtn'),
  resumeBadge: $('resumeBadge'),
  backdrop: $('backdrop'), sidebar: $('sidebar'),
  catPanel: $('catPanel'), chPanel: $('chPanel'),
  catScroll: $('catScroll'), catSpacer: $('catSpacer'), catWin: $('catWin'),
  chScroll: $('chScroll'), chSpacer: $('chSpacer'), chWin: $('chWin'),
  catBadge: $('catBadge'), chBadge: $('chBadge'),
  catSearch: $('catSearch'), chSearch: $('chSearch'), chTitle: $('chTitle'),
  settingsOverlay: $('settingsOverlay'),
  inServer: $('inServer'), inUser: $('inUser'), inPass: $('inPass'), inFormat: $('inFormat'),
  togRemember: $('togRemember'),
  settProg: $('settProg'), settMsg: $('settMsg'),
  btnConnect: $('btnConnect'), btnClear: $('btnClear'),
  connectingScreen: $('connectingScreen'),
  connectMsg: $('connectMsg'), connectProg: $('connectProg'),
};

const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const esc = s => String(s).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
function normServer(s) { s = (s || '').trim(); if (!s) return ''; if (!/^https?:\/\//i.test(s)) s = 'http://' + s; return s.replace(/\/+$/, ''); }
function apiUrl(p) {
  const u = new URL(S.server + '/player_api.php');
  u.searchParams.set('username', S.user);
  u.searchParams.set('password', S.pass);
  for (const [k, v] of Object.entries(p)) u.searchParams.set(k, v);
  return u.toString();
}
async function jget(url) { const r = await fetch(url); if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }

function saveSettings() {
  localStorage.setItem(SAVE_KEY, JSON.stringify({
    server: S.server, user: S.user, pass: S.pass, fmt: S.fmt,
    rememberChannel: S.rememberChannel,
  }));
}
function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(SAVE_KEY) || '{}');
    if (s.server) {
      D.inServer.value = s.server; D.inUser.value = s.user || '';
      D.inPass.value = s.pass || ''; D.inFormat.value = s.fmt || 'm3u8';
    }
    S.rememberChannel = s.rememberChannel !== false;
    D.togRemember.checked = S.rememberChannel;
    return s;
  } catch { return {}; }
}
function saveLastChannel(ch) {
  if (!S.rememberChannel) return;
  try {
    localStorage.setItem(LAST_KEY, JSON.stringify({
      streamId: String(ch.stream_id),
      name: ch.name || '',
      catId: S.activeCatId,
    }));
  } catch {}
}
function loadLastChannel() {
  try { return JSON.parse(localStorage.getItem(LAST_KEY) || 'null'); } catch { return null; }
}

function showHud(title, sub) {
  D.hudTitle.textContent = title || '';
  D.hudSub.textContent = sub || '';
  D.hud.classList.remove('hide');
  clearTimeout(S.hudTimer); clearTimeout(S.hudHideTimer);
  S.hudTimer = setTimeout(() => {
    if (!S.sidebarOpen && !S.settingsOpen) S.hudHideTimer = setTimeout(() => D.hud.classList.add('hide'), 1500);
  }, 3500);
}
function wakeHud() {
  if (S.settingsOpen) return;
  D.hud.classList.remove('hide');
  clearTimeout(S.hudHideTimer);
  if (!S.sidebarOpen) S.hudHideTimer = setTimeout(() => D.hud.classList.add('hide'), 4000);
}

function openSettings() {
  S.settingsOpen = true;
  D.settingsOverlay.classList.add('show');
  D.hud.classList.add('hide');
  closeSidebar();
  setTimeout(() => D.inServer.focus(), 60);
}
function closeSettings() {
  S.settingsOpen = false;
  D.settingsOverlay.classList.remove('show');
  D.settProg.style.width = '0';
  setMsg('');
  if (S.connected) wakeHud();
}
function setMsg(t, err) {
  D.settMsg.textContent = t;
  D.settMsg.className = 'msg ' + (err ? 'err' : 'ok');
}
function setSettProg(p) { D.settProg.style.width = p + '%'; }

function showConnecting(msg, pct) {
  D.connectingScreen.classList.add('show');
  D.connectMsg.textContent = msg;
  D.connectProg.style.width = pct + '%';
}
function hideConnecting() { D.connectingScreen.classList.remove('show'); }

function openSidebar() {
  S.sidebarOpen = true;
  D.sidebar.classList.add('open');
  D.backdrop.classList.add('open');
  D.hud.classList.remove('hide');
  clearTimeout(S.hudHideTimer);
  setFocus(S.focus === 'categories' ? 'categories' : 'channels');
}
function closeSidebar() {
  S.sidebarOpen = false;
  D.sidebar.classList.remove('open');
  D.backdrop.classList.remove('open');
  clearTimeout(S.hudHideTimer);
  if (!S.settingsOpen) S.hudHideTimer = setTimeout(() => D.hud.classList.add('hide'), 3500);
}
function setFocus(f) {
  S.focus = f;
  D.catPanel.classList.toggle('active', f === 'categories');
  D.chPanel.classList.toggle('active', f === 'channels');
}

class VList {
  constructor(scroll, spacer, win, getItems, makeNode, onPick) {
    this.scroll = scroll; this.spacer = spacer; this.win = win;
    this.getItems = getItems; this.makeNode = makeNode; this.onPick = onPick;
    this._raf = null;
    scroll.addEventListener('scroll', () => this._sched(), { passive: true });
  }
  _sched() { if (this._raf) return; this._raf = requestAnimationFrame(() => { this._raf = null; this.paint(); }); }
  paint() {
    const items = this.getItems(); const n = items.length;
    this.spacer.style.height = n * ITEM_H + 'px';
    const st = this.scroll.scrollTop; const vh = this.scroll.clientHeight;
    const first = Math.max(0, Math.floor(st / ITEM_H) - OVERSCAN);
    const last = Math.min(n - 1, Math.ceil((st + vh) / ITEM_H) + OVERSCAN);
    for (const nd of [...this.win.children]) if (+nd.dataset.i < first || +nd.dataset.i > last) nd.remove();
    const ex = new Map(); for (const nd of this.win.children) ex.set(+nd.dataset.i, nd);
    for (let i = first; i <= last; i++) {
      let nd = ex.get(i);
      if (!nd) { nd = this.makeNode(items[i], i); nd.dataset.i = i; nd.addEventListener('click', () => this.onPick(i)); this.win.appendChild(nd); }
      nd.style.top = (i * ITEM_H + 3) + 'px';
      this.applyState(nd, items[i], i);
    }
  }
  applyState() {}
  scrollTo(i) {
    const n = this.getItems().length; if (!n) return;
    i = clamp(i, 0, n - 1);
    const top = i * ITEM_H; const bot = top + ITEM_H; const st = this.scroll.scrollTop; const vh = this.scroll.clientHeight;
    if (top < st) this.scroll.scrollTop = top;
    else if (bot > st + vh) this.scroll.scrollTop = bot - vh;
  }
}

const catList = new VList(
  D.catScroll, D.catSpacer, D.catWin,
  () => S.catsFiltered,
  cat => { const d = document.createElement('div'); d.className = 'item'; d.innerHTML = `<div class="dot"></div><div class="meta"><div class="iname">${esc(cat.category_name || 'Unnamed')}</div></div>`; return d; },
  i => { S.selCat = i; catList.paint(); loadCat(S.catsFiltered[i], true); setFocus('channels'); },
);
catList.applyState = (nd, item, i) => nd.classList.toggle('sel', i === S.selCat);

const chList = new VList(
  D.chScroll, D.chSpacer, D.chWin,
  () => S.channels,
  ch => { const d = document.createElement('div'); d.className = 'item'; d.innerHTML = `<div class="dot"></div><div class="meta"><div class="iname">${esc(ch.name || 'Channel')}</div><div class="isub">ID ${esc(String(ch.stream_id))}</div></div>`; return d; },
  i => { S.selCh = i; playSelected(); closeSidebar(); },
);
chList.applyState = (nd, item, i) => {
  nd.classList.toggle('sel', i === S.selCh);
  nd.classList.toggle('playing', String(item.stream_id) === String(S.playingId));
};

function paintCats() { D.catBadge.textContent = String(S.catsFiltered.length); catList.paint(); }
function paintChs() { D.chBadge.textContent = String(S.channels.length); chList.paint(); }

async function connect(fromSettings = false) {
  S.server = normServer(D.inServer.value);
  S.user = (D.inUser.value || '').trim();
  S.pass = (D.inPass.value || '').trim();
  S.fmt = (D.inFormat.value || 'm3u8').trim().toLowerCase();
  if (S.fmt !== 'ts') S.fmt = 'm3u8';
  S.rememberChannel = D.togRemember.checked;
  if (!S.server || !S.user || !S.pass) {
    if (fromSettings) setMsg('Fill in all fields.', true);
    return false;
  }

  if (fromSettings) { setSettProg(10); setMsg('Connecting…'); D.btnConnect.disabled = true; }
  else { closeSettings(); showConnecting('Connecting…', 10); }

  try {
    const auth = await jget(apiUrl({}));
    if (!auth?.user_info?.auth) throw new Error('Auth failed');

    if (fromSettings) { setSettProg(45); setMsg('Loading categories…'); }
    else showConnecting('Loading categories…', 45);

    const raw = await jget(apiUrl({ action: 'get_live_categories' }));
    const allCats = Array.isArray(raw) ? raw : [];
    allCats.sort((a, b) => (+a.category_id || 0) - (+b.category_id || 0));
    S.cats = allCats.filter(c => String(c.category_name || '').toUpperCase().includes('ALBANIA'));

    saveSettings();

    S.catsFiltered = S.cats.slice();
    S.chCache.clear(); S.channels = []; S.selCh = 0;
    S.selCat = 0;
    S.connected = true;

    if (fromSettings) { setSettProg(100); setMsg('Connected! ' + S.cats.length + ' categories.'); }
    else showConnecting('Ready!', 100);

    paintCats(); paintChs();
    catList.scrollTo(S.selCat);

    const defCat = S.catsFiltered[0];
    if (defCat) await loadCat(defCat, false);

    if (!fromSettings) hideConnecting();

    try { document.documentElement.requestFullscreen(); } catch {}

    const last = loadLastChannel();
    if (last && S.rememberChannel) await resumeLastChannel(last);
    else showHud('Ready', defCat ? defCat.category_name + ' — OK to open list' : 'OK to open channel list');

    if (fromSettings) setTimeout(closeSettings, 1200);
    return true;
  } catch (e) {
    const msg = 'Failed: ' + (e?.message || e);
    if (fromSettings) { setMsg(msg, true); setSettProg(0); }
    else { hideConnecting(); openSettings(); setMsg(msg, true); }
    return false;
  } finally {
    D.btnConnect.disabled = false;
  }
}

async function resumeLastChannel(last) {
  const cat = S.cats.find(c => String(c.category_id) === String(last.catId)) || S.cats[0];
  if (!cat) return;
  const id = String(cat.category_id);
  if (!S.chCache.has(id)) {
    try {
      const url = apiUrl({ action: 'get_live_streams', category_id: id });
      const data = await jget(url);
      const chs = Array.isArray(data) ? data : [];
      chs.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
      S.chCache.set(id, chs);
    } catch { return; }
  }
  const chs = S.chCache.get(id) || [];
  const idx = chs.findIndex(c => String(c.stream_id) === String(last.streamId));
  if (idx < 0) return;

  S.activeCatId = id;
  D.chTitle.textContent = cat.category_name || 'Channels';
  S.channels = chs.slice();
  S.selCat = S.catsFiltered.findIndex(c => String(c.category_id) === id);
  if (S.selCat < 0) S.selCat = 0;
  S.selCh = idx;
  paintCats(); paintChs();
  catList.scrollTo(S.selCat); chList.scrollTo(S.selCh);

  D.resumeBadge.textContent = '▶ Resuming: ' + last.name;
  D.resumeBadge.classList.add('show');
  setTimeout(() => D.resumeBadge.classList.remove('show'), 3500);

  playChannel(chs[idx]);
}

async function loadCat(cat, resetSel) {
  if (!cat) return;
  const id = String(cat.category_id);
  S.activeCatId = id;
  D.chTitle.textContent = cat.category_name || 'Channels';
  if (resetSel) S.selCh = 0;
  S.chQ = ''; D.chSearch.value = '';
  S.channels = []; paintChs();
  D.chWin.innerHTML = '<div class="spinner"><div class="spin"></div>Loading…</div>';
  D.chSpacer.style.height = '0';
  if (S.chCache.has(id)) { applyChannels(S.chCache.get(id), id); return; }
  try {
    const url = id === '0' ? apiUrl({ action: 'get_live_streams' }) : apiUrl({ action: 'get_live_streams', category_id: id });
    const data = await jget(url);
    const chs = Array.isArray(data) ? data : [];
    chs.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
    S.chCache.set(id, chs);
    if (S.activeCatId === id) applyChannels(chs, id);
  } catch (e) {
    if (S.activeCatId === id) D.chWin.innerHTML = `<div class="spinner" style="color:#f66">Error: ${esc(e.message)}</div>`;
  }
}
function applyChannels(chs, id) {
  const q = S.chQ.toLowerCase();
  S.channels = q ? chs.filter(c => String(c.name || '').toLowerCase().includes(q)) : chs.slice();
  S.selCh = clamp(S.selCh, 0, Math.max(0, S.channels.length - 1));
  paintChs();
  const cat = S.catsFiltered.find(c => String(c.category_id) === id);
  if (cat) showHud(cat.category_name, S.channels.length + ' channels');
}

D.catSearch.addEventListener('input', () => {
  S.catQ = D.catSearch.value.toLowerCase();
  S.catsFiltered = S.catQ ? S.cats.filter(c => String(c.category_name || '').toLowerCase().includes(S.catQ)) : S.cats.slice();
  S.selCat = 0; paintCats();
});
D.chSearch.addEventListener('input', () => {
  S.chQ = D.chSearch.value;
  const cat = S.catsFiltered[S.selCat]; if (!cat) return;
  const id = String(cat.category_id); const cached = S.chCache.get(id);
  if (cached) applyChannels(cached, id);
});

function clearEpg() {
  clearInterval(S.epgRefreshTimer);
  clearTimeout(S.epgTimer);
  D.epgBlock.classList.remove('show');
  D.epgNowTitle.textContent = '';
  D.epgNowTime.textContent = '';
  D.epgBarFill.style.width = '0';
  D.epgNext.textContent = '';
}
function fmtTime(ts) { const d = new Date(ts * 1000); return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }); }
function fmtMinsLeft(endTs) { const mins = Math.round((endTs * 1000 - Date.now()) / 60000); if (mins <= 0) return 'ending'; if (mins === 1) return '1 min left'; return mins + ' min left'; }
function renderEpg(now, next) {
  if (!now) { clearEpg(); return; }
  const nowSec = Date.now() / 1000;
  const start = now.start || now.start_timestamp || 0;
  const end = now.end || now.stop_timestamp || now.end_timestamp || 0;
  const dur = end - start;
  const pct = dur > 0 ? Math.min(100, Math.round((nowSec - start) / dur * 100)) : 0;
  const title = now.title || now.name || '';

  D.epgNowTitle.textContent = title;
  D.epgNowTime.textContent = end ? fmtTime(start) + ' – ' + fmtTime(end) + '  •  ' + fmtMinsLeft(end) : fmtTime(start);
  D.epgBarFill.style.width = pct + '%';

  if (next) {
    const nt = next.title || next.name || '';
    const ns = next.start || next.start_timestamp || 0;
    D.epgNext.textContent = nt ? 'Next  ' + fmtTime(ns) + '  ' + nt : '';
  } else D.epgNext.textContent = '';

  D.epgBlock.classList.add('show');
}

async function fetchEpg(streamId) {
  clearEpg();
  try {
    const url = apiUrl({ action: 'get_short_epg', stream_id: streamId, limit: '2' });
    const data = await jget(url);
    const list = data?.epg_listings || data?.Epg_listings || [];
    if (!list.length) { clearEpg(); return; }

    const decode = s => { try { return atob(s); } catch { return s; } };
    const entries = list.map(e => ({
      title: decode(e.title || e.name || ''),
      start: parseInt(e.start || e.start_timestamp || 0, 10),
      end: parseInt(e.end || e.stop_timestamp || e.end_timestamp || 0, 10),
    }));

    const now = Date.now() / 1000;
    let curIdx = entries.findIndex(e => e.start <= now && e.end > now);
    if (curIdx < 0) curIdx = 0;

    renderEpg(entries[curIdx], entries[curIdx + 1] || null);

    clearInterval(S.epgRefreshTimer);
    S.epgRefreshTimer = setInterval(() => {
      const n = Date.now() / 1000;
      const cur = entries[curIdx];
      if (cur && cur.end > 0 && n >= cur.end) {
        clearInterval(S.epgRefreshTimer);
        fetchEpg(streamId);
      } else renderEpg(entries[curIdx], entries[curIdx + 1] || null);
    }, 30000);
  } catch {
    clearEpg();
  }
}

function stopPlayback() {
  if (S.hls) { try { S.hls.destroy(); } catch {} S.hls = null; }
  if (S.mts) { try { S.mts.destroy(); } catch {} S.mts = null; }
  D.video.oncanplay = null; D.video.onerror = null;
  D.video.pause(); D.video.removeAttribute('src'); D.video.load();
  clearEpg();
}
function playSelected() { const ch = S.channels[S.selCh]; if (ch) playChannel(ch); }
function playChannel(ch, forceExt) {
  const attempt = forceExt || 'm3u8';
  const realExt = attempt.startsWith('m3u8') ? 'm3u8' : 'ts';
  const url = `${S.server}/live/${encodeURIComponent(S.user)}/${encodeURIComponent(S.pass)}/${encodeURIComponent(String(ch.stream_id))}.${realExt}`;
  S.playingId = String(ch.stream_id); S.currentUrl = url;
  chList.paint(); stopPlayback();
  showHud(ch.name || 'Playing', 'Connecting…');

  saveLastChannel(ch);

  const fallback = reason => {
    console.warn('[Player] fallback from', attempt, '—', reason);
    stopPlayback();
    if (attempt === 'm3u8') {
      showHud(ch.name || '', '⚠ Multi-audio issue — retrying…');
      setTimeout(() => playChannel(ch, 'm3u8-noaudio'), 200);
    } else if (attempt === 'm3u8-noaudio') {
      showHud(ch.name || '', '⚠ Trying TS stream…');
      setTimeout(() => playChannel(ch, 'ts'), 200);
    } else showHud('Cannot play', reason);
  };

  function tryPlay() {
    const p = D.video.play();
    if (p) p.catch(e => { if (e.name === 'NotAllowedError') { D.video.muted = true; D.video.play().catch(() => {}); } });
  }

  if (realExt === 'm3u8' && window.Hls && Hls.isSupported()) {
    const hlsCfg = {
      lowLatencyMode: true,
      backBufferLength: 30,
      enableWorker: false,
      maxBufferLength: 10,
      maxMaxBufferLength: 30,
      fragLoadingTimeOut: 10000,
      manifestLoadingTimeOut: 10000,
      fragLoadingMaxRetry: 2,
      manifestLoadingMaxRetry: 2,
      startLevel: 0,
      audioTrackController: undefined,
      recoverMediaError: true,
      xhrSetup(xhr) { xhr.withCredentials = false; try { xhr.referrerPolicy = 'no-referrer'; } catch {} },
    };

    if (attempt === 'm3u8-noaudio') {
      hlsCfg.audioCodec = 'mp4a.40.2';
      hlsCfg.forceKeyFrameOnDiscontinuity = false;
    }

    const hls = new Hls(hlsCfg);
    S.hls = hls;

    let mediaRecovered = false;
    hls.on(Hls.Events.ERROR, (_, d) => {
      console.warn('[HLS]', d.type, d.details, 'fatal:', d.fatal, d);
      if (!d.fatal) {
        if (d.details === Hls.ErrorDetails.BUFFER_INCOMPATIBLE_CODECS_ERROR
          || d.details === Hls.ErrorDetails.BUFFER_ADD_CODEC_ERROR
          || d.type === Hls.ErrorTypes.MEDIA_ERROR) {
          if (!mediaRecovered) {
            mediaRecovered = true;
            hls.recoverMediaError();
          }
        }
        return;
      }
      if (d.details === Hls.ErrorDetails.BUFFER_INCOMPATIBLE_CODECS_ERROR
        || d.details === Hls.ErrorDetails.BUFFER_ADD_CODEC_ERROR) fallback('incompatible-codec');
      else fallback(d.details || d.type);
    });

    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      if (hls.audioTracks && hls.audioTracks.length > 1) hls.audioTrack = 0;
      showHud(ch.name || 'Playing', '▶ Live');
      tryPlay();
      fetchEpg(ch.stream_id);
    });

    let frags = 0;
    hls.on(Hls.Events.FRAG_BUFFERED, () => {
      if (++frags === 3) {
        const q = D.video.getVideoPlaybackQuality?.();
        const frames = q ? q.totalVideoFrames : (D.video.webkitDecodedFrameCount || 0);
        if (frames === 0) fallback('interlaced-no-frames');
      }
    });

    hls.attachMedia(D.video);
    hls.loadSource(url);
  } else if (realExt === 'ts' && window.mpegts && mpegts.isSupported()) {
    const p = mpegts.createPlayer({ type: 'mpegts', url, isLive: true }, {
      enableWorker: true,
      lazyLoadMaxDuration: 3,
      liveBufferLatencyChasing: true,
      liveBufferLatencyMinRemain: 0.5,
      accurateSeek: false,
    });
    S.mts = p;
    p.attachMediaElement(D.video);
    p.load();
    showHud(ch.name || 'Playing', '▶ TS Live');
    tryPlay();
    fetchEpg(ch.stream_id);
    p.on(mpegts.Events.ERROR, (t, d) => {
      if (t === mpegts.ErrorTypes.MEDIA_ERROR && d === mpegts.ErrorDetails.MEDIA_MSE_ERROR) fallback(t + ':' + d);
      else showHud(ch.name || '', '⚠ ' + t);
    });
  } else {
    D.video.src = url;
    D.video.oncanplay = () => { showHud(ch.name || 'Playing', '▶ Live'); fetchEpg(ch.stream_id); D.video.oncanplay = null; };
    D.video.onerror = () => fallback(D.video.error?.message || 'native error');
    tryPlay();
  }
}

function zap(d) {
  if (!S.channels.length) return;
  S.selCh = clamp(S.selCh + d, 0, S.channels.length - 1);
  chList.scrollTo(S.selCh); chList.paint();
  showHud(S.channels[S.selCh]?.name || '', 'OK to play');
}
function zapPlay(d) {
  if (!S.channels.length) return;
  S.selCh = clamp(S.selCh + d, 0, S.channels.length - 1);
  chList.scrollTo(S.selCh); playSelected();
}

window.addEventListener('keydown', e => {
  const k = e.key;

  if (S.settingsOpen) {
    const settFields = [D.inServer, D.inUser, D.inPass, D.inFormat, D.togRemember, D.btnConnect, D.btnClear];
    if (k === 'Escape' || k === 'Backspace' || k === 'BrowserBack') { e.preventDefault(); closeSettings(); return; }
    if (k === 'Enter') { const ae = document.activeElement; if (ae === D.btnClear) { localStorage.removeItem(SAVE_KEY); localStorage.removeItem(LAST_KEY); setMsg('Cleared.'); return; } connect(true); return; }
    if (k === 'ArrowDown' || k === 'ArrowUp') {
      const i = settFields.indexOf(document.activeElement);
      if (i >= 0) { e.preventDefault(); const ni = k === 'ArrowDown' ? Math.min(i + 1, settFields.length - 1) : Math.max(i - 1, 0); settFields[ni].focus(); }
    }
    return;
  }

  if (e.target === D.catSearch || e.target === D.chSearch) { if (k === 'Escape') e.target.blur(); return; }

  wakeHud();

  if (k === 'f' || k === 'F') {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen().catch(() => {});
    else document.exitFullscreen();
    return;
  }

  if (!S.sidebarOpen) {
    if (k === 'Enter' || k === 'OK' || k === ' ') { e.preventDefault(); openSidebar(); return; }
    if (k === 'ArrowUp' || k === 'PageUp' || k === 'MediaTrackPrevious') { e.preventDefault(); zapPlay(-1); return; }
    if (k === 'ArrowDown' || k === 'PageDown' || k === 'MediaTrackNext') { e.preventDefault(); zapPlay(+1); return; }
    return;
  }

  e.preventDefault();
  if (k === 'Escape' || k === 'Backspace' || k === 'BrowserBack' || k === 'GoBack') {
    if (S.focus === 'categories') setFocus('channels');
    else closeSidebar();
    return;
  }
  if (k === 'ArrowLeft' && S.focus === 'channels') { setFocus('categories'); return; }
  if (k === 'ArrowRight' && S.focus === 'categories') { setFocus('channels'); return; }
  if (k === 'ArrowUp') {
    if (S.focus === 'categories') {
      S.selCat = clamp(S.selCat - 1, 0, S.catsFiltered.length - 1);
      catList.scrollTo(S.selCat); catList.paint();
      showHud(S.catsFiltered[S.selCat]?.category_name || '', 'OK to open');
    } else zap(-1);
    return;
  }
  if (k === 'ArrowDown') {
    if (S.focus === 'categories') {
      S.selCat = clamp(S.selCat + 1, 0, S.catsFiltered.length - 1);
      catList.scrollTo(S.selCat); catList.paint();
      showHud(S.catsFiltered[S.selCat]?.category_name || '', 'OK to open');
    } else zap(+1);
    return;
  }
  if (k === 'Enter' || k === 'OK' || k === ' ') {
    if (S.focus === 'categories') { const cat = S.catsFiltered[S.selCat]; if (cat) { loadCat(cat, true); setFocus('channels'); } }
    else { playSelected(); closeSidebar(); }
  }
}, { passive: false });

D.backdrop.addEventListener('click', closeSidebar);
D.settingsBtn.addEventListener('click', openSettings);
D.btnConnect.addEventListener('click', () => connect(true));
D.btnClear.addEventListener('click', () => { localStorage.removeItem(SAVE_KEY); localStorage.removeItem(LAST_KEY); setMsg('Cleared.'); });
D.togRemember.addEventListener('change', () => { S.rememberChannel = D.togRemember.checked; });

(async () => {
  const saved = loadSettings();
  if (saved.server && saved.user && saved.pass) {
    D.inServer.value = saved.server; D.inUser.value = saved.user;
    D.inPass.value = saved.pass; D.inFormat.value = saved.fmt || 'm3u8';
    await connect(false);
  } else openSettings();
})();

})();
