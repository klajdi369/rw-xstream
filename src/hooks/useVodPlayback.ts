import React from 'react';
import { VodProgress, VodStream } from '../types/player';
import { normServer } from '../utils';
import {
  VOD_PROGRESS_KEY,
  VOD_PROGRESS_SAVE_INTERVAL_MS,
  VOD_RESUME_END_PAD_SECONDS,
  VOD_RESUME_MIN_SECONDS,
  VOD_SEEK_STEP_SECONDS,
} from '../constants';

interface UseVodPlaybackOptions {
  videoRef: React.RefObject<HTMLVideoElement>;
  server: string;
  user: string;
  pass: string;
}

export interface TrackInfo {
  id: string;
  label: string;
}

// Minimal shape of the non-standard HTMLMediaElement.audioTracks (WebKit family).
interface AudioTrackLike { id?: string; label?: string; language?: string; enabled: boolean; }
interface AudioTrackListLike {
  length: number;
  [index: number]: AudioTrackLike;
  addEventListener?: (type: string, listener: () => void) => void;
  removeEventListener?: (type: string, listener: () => void) => void;
}

export interface VodPlaybackState {
  activeId: string | null;
  title: string;
  current: number;
  duration: number;
  paused: boolean;
  buffering: boolean;
  error: string;
  audioTracks: TrackInfo[];
  activeAudioId: string | null;
  textTracks: TrackInfo[];
  activeTextId: string | null; // null = subtitles off
}

const INITIAL: VodPlaybackState = {
  activeId: null,
  title: '',
  current: 0,
  duration: 0,
  paused: false,
  buffering: false,
  error: '',
  audioTracks: [],
  activeAudioId: null,
  textTracks: [],
  activeTextId: null,
};

function readProgressMap(): Record<string, VodProgress> {
  try {
    const parsed = JSON.parse(localStorage.getItem(VOD_PROGRESS_KEY) || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeProgress(id: string, position: number, duration: number) {
  try {
    const map = readProgressMap();
    // Once a title is basically finished, forget its resume point so it starts
    // fresh next time rather than jumping to the credits.
    if (duration > 0 && position >= duration - VOD_RESUME_END_PAD_SECONDS) {
      delete map[id];
    } else if (position >= VOD_RESUME_MIN_SECONDS) {
      map[id] = { position, duration, updatedAt: Date.now() };
    }
    localStorage.setItem(VOD_PROGRESS_KEY, JSON.stringify(map));
  } catch {
    /* storage full / unavailable — resume is best-effort */
  }
}

/**
 * Progressive, seekable playback for VOD (movies). Unlike the live player this
 * uses the native <video> element directly on the `.../movie/...` URL — the file
 * supports HTTP range requests, so scrubbing and resume just work. It shares no
 * state with the live player and manages its own <video> element.
 */
export function useVodPlayback({ videoRef, server, user, pass }: UseVodPlaybackOptions) {
  const [state, setState] = React.useState<VodPlaybackState>(INITIAL);
  const activeIdRef = React.useRef<string | null>(null);
  const durationRef = React.useRef(0);
  const saveTimerRef = React.useRef<ReturnType<typeof setInterval> | null>(null);

  const persistNow = React.useCallback(() => {
    const v = videoRef.current;
    const id = activeIdRef.current;
    if (!v || !id || !Number.isFinite(v.currentTime)) return;
    writeProgress(id, v.currentTime, durationRef.current || v.duration || 0);
  }, [videoRef]);

  const stopSaveTimer = React.useCallback(() => {
    if (saveTimerRef.current) {
      clearInterval(saveTimerRef.current);
      saveTimerRef.current = null;
    }
  }, []);

  const stop = React.useCallback(() => {
    persistNow();
    stopSaveTimer();
    const v = videoRef.current;
    if (v) {
      v.pause();
      v.removeAttribute('src');
      v.load();
    }
    activeIdRef.current = null;
    durationRef.current = 0;
    setState(INITIAL);
  }, [persistNow, stopSaveTimer, videoRef]);

  const play = React.useCallback((movie: VodStream) => {
    const v = videoRef.current;
    if (!v) return;

    // Persist wherever we were before switching titles.
    persistNow();
    stopSaveTimer();

    const id = String(movie.stream_id);
    const ext = String(movie.container_extension || 'mp4').replace(/^\./, '');
    const url = `${normServer(server)}/movie/${encodeURIComponent(user)}/${encodeURIComponent(pass)}/${encodeURIComponent(id)}.${ext}`;

    activeIdRef.current = id;
    durationRef.current = 0;
    setState({ ...INITIAL, activeId: id, title: movie.name || 'Movie', buffering: true });

    const resumeFrom = readProgressMap()[id]?.position ?? 0;

    v.src = url;
    v.load();

    const onLoadedMeta = () => {
      durationRef.current = v.duration || 0;
      if (resumeFrom > VOD_RESUME_MIN_SECONDS && (!v.duration || resumeFrom < v.duration - VOD_RESUME_END_PAD_SECONDS)) {
        try { v.currentTime = resumeFrom; } catch { /* seek not ready */ }
      }
      v.play().catch(() => { /* autoplay may require a gesture */ });
    };
    v.addEventListener('loadedmetadata', onLoadedMeta, { once: true });

    // Persist progress periodically so a crash/close keeps the resume point.
    saveTimerRef.current = setInterval(persistNow, VOD_PROGRESS_SAVE_INTERVAL_MS);
  }, [persistNow, pass, server, stopSaveTimer, user, videoRef]);

  const togglePause = React.useCallback(() => {
    const v = videoRef.current;
    if (!v || !activeIdRef.current) return;
    if (v.paused) v.play().catch(() => { /* noop */ });
    else v.pause();
  }, [videoRef]);

  const seekBy = React.useCallback((deltaSeconds: number = VOD_SEEK_STEP_SECONDS) => {
    const v = videoRef.current;
    if (!v || !activeIdRef.current) return;
    const dur = durationRef.current || v.duration || 0;
    const next = v.currentTime + deltaSeconds;
    v.currentTime = dur ? Math.max(0, Math.min(next, dur - 1)) : Math.max(0, next);
    persistNow();
  }, [persistNow, videoRef]);

  // ── Audio / subtitle tracks ─────────────────────────────────────────────────
  // Whatever the browser exposes for the currently-loaded file. Availability is
  // very browser- and container-dependent (audioTracks in particular is only in
  // WebKit-family browsers, which is what most TVs run), so this is best-effort:
  // if the lists come back empty the UI simply says none are selectable.
  const enumerateTracks = React.useCallback(() => {
    const v = videoRef.current;
    if (!v) return;

    const audioList: TrackInfo[] = [];
    let activeAudioId: string | null = null;
    // `audioTracks` isn't in the standard DOM typings — feature-detect it.
    const at = (v as unknown as { audioTracks?: AudioTrackListLike }).audioTracks;
    if (at && at.length) {
      for (let i = 0; i < at.length; i += 1) {
        const t = at[i];
        const id = String(t.id || i);
        audioList.push({ id, label: t.label || t.language || `Audio ${i + 1}` });
        if (t.enabled) activeAudioId = id;
      }
      if (!activeAudioId && audioList[0]) activeAudioId = audioList[0].id;
    }

    const textList: TrackInfo[] = [];
    let activeTextId: string | null = null;
    const tt = v.textTracks;
    if (tt && tt.length) {
      for (let i = 0; i < tt.length; i += 1) {
        const t = tt[i];
        if (t.kind === 'metadata' || t.kind === 'chapters') continue;
        const id = String(i); // index into textTracks — used to switch it back
        textList.push({ id, label: t.label || t.language || `Subtitle ${i + 1}` });
        if (t.mode === 'showing') activeTextId = id;
      }
    }

    setState((s) => (s.activeId
      ? { ...s, audioTracks: audioList, activeAudioId, textTracks: textList, activeTextId }
      : s));
  }, [videoRef]);

  const selectAudio = React.useCallback((id: string) => {
    const v = videoRef.current;
    const at = v && (v as unknown as { audioTracks?: AudioTrackListLike }).audioTracks;
    if (!at) return;
    for (let i = 0; i < at.length; i += 1) at[i].enabled = String(at[i].id || i) === id;
    setState((s) => ({ ...s, activeAudioId: id }));
  }, [videoRef]);

  const selectText = React.useCallback((id: string | null) => {
    const v = videoRef.current;
    const tt = v?.textTracks;
    if (!tt) return;
    for (let i = 0; i < tt.length; i += 1) {
      if (tt[i].kind === 'metadata' || tt[i].kind === 'chapters') continue;
      tt[i].mode = id !== null && String(i) === id ? 'showing' : 'disabled';
    }
    setState((s) => ({ ...s, activeTextId: id }));
  }, [videoRef]);

  // Wire <video> events → state. Bound once against the stable element.
  React.useEffect(() => {
    const v = videoRef.current;
    if (!v) return;

    const sync = () => setState((s) => (
      s.activeId
        ? {
          ...s,
          current: v.currentTime || 0,
          duration: durationRef.current || v.duration || 0,
          paused: v.paused,
        }
        : s
    ));
    const onWaiting = () => setState((s) => (s.activeId ? { ...s, buffering: true } : s));
    const onPlaying = () => setState((s) => (s.activeId ? { ...s, buffering: false, paused: false } : s));
    const onPause = () => setState((s) => (s.activeId ? { ...s, paused: true } : s));
    const onEnded = () => { persistNow(); };
    const onError = () => setState((s) => (
      s.activeId
        ? { ...s, buffering: false, error: 'Could not play this title (unsupported format or unreachable).' }
        : s
    ));

    // Track lists can arrive after metadata; re-scan on these and on list changes.
    const onTracks = () => enumerateTracks();
    const at = (v as unknown as { audioTracks?: AudioTrackListLike }).audioTracks;
    const tt = v.textTracks as unknown as (TextTrackList & { addEventListener?: (t: string, l: () => void) => void; removeEventListener?: (t: string, l: () => void) => void }) | undefined;

    v.addEventListener('timeupdate', sync);
    v.addEventListener('durationchange', sync);
    v.addEventListener('waiting', onWaiting);
    v.addEventListener('playing', onPlaying);
    v.addEventListener('pause', onPause);
    v.addEventListener('ended', onEnded);
    v.addEventListener('error', onError);
    v.addEventListener('loadedmetadata', onTracks);
    v.addEventListener('canplay', onTracks);
    at?.addEventListener?.('addtrack', onTracks);
    at?.addEventListener?.('removetrack', onTracks);
    at?.addEventListener?.('change', onTracks);
    tt?.addEventListener?.('addtrack', onTracks);
    tt?.addEventListener?.('removetrack', onTracks);
    tt?.addEventListener?.('change', onTracks);

    return () => {
      v.removeEventListener('timeupdate', sync);
      v.removeEventListener('durationchange', sync);
      v.removeEventListener('waiting', onWaiting);
      v.removeEventListener('playing', onPlaying);
      v.removeEventListener('pause', onPause);
      v.removeEventListener('ended', onEnded);
      v.removeEventListener('error', onError);
      v.removeEventListener('loadedmetadata', onTracks);
      v.removeEventListener('canplay', onTracks);
      at?.removeEventListener?.('addtrack', onTracks);
      at?.removeEventListener?.('removetrack', onTracks);
      at?.removeEventListener?.('change', onTracks);
      tt?.removeEventListener?.('addtrack', onTracks);
      tt?.removeEventListener?.('removetrack', onTracks);
      tt?.removeEventListener?.('change', onTracks);
    };
  }, [enumerateTracks, persistNow, videoRef]);

  React.useEffect(() => () => { stopSaveTimer(); }, [stopSaveTimer]);

  return { state, play, stop, togglePause, seekBy, selectAudio, selectText };
}
