import React from 'react';
import { Category, VodStream } from '../types/player';
import { VirtualList } from './VirtualList';
import { useVod } from '../hooks/useVod';
import { useVodPlayback } from '../hooks/useVodPlayback';
import { clamp } from '../utils';
import { CHANNEL_ROW_JUMP, VOD_SEEK_STEP_SECONDS } from '../constants';

interface VodModeProps {
  apiUrl: (params: Record<string, string>) => string;
  jget: (url: string) => Promise<unknown>;
  server: string;
  user: string;
  pass: string;
  onExit: () => void;
}

function fmtDuration(secs: number): string {
  if (!Number.isFinite(secs) || secs <= 0) return '0:00';
  const t = Math.floor(secs);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

/**
 * Self-contained VOD (movies) experience: its own <video> element, its own
 * browse overlay, its own transport controls and its own keyboard handling.
 * It touches nothing in the live path — the parent simply stops live playback
 * and mounts this on top; unmounting returns cleanly to live.
 */
export function VodMode({ apiUrl, jget, server, user, pass, onExit }: VodModeProps) {
  const vodVideoRef = React.useRef<HTMLVideoElement>(null);
  const movieSearchRef = React.useRef<HTMLInputElement>(null);

  const {
    categories, streams, activeCatId, loading, error,
    allStreams, allLoading, loadCategories, loadStreams, loadAllStreams,
  } = useVod({ apiUrl, jget });
  const { state, play, stop, togglePause, seekBy } = useVodPlayback({ videoRef: vodVideoRef, server, user, pass });

  const [browseOpen, setBrowseOpen] = React.useState(true);
  const [focus, setFocus] = React.useState<'categories' | 'movies'>('categories');
  const [selCat, setSelCat] = React.useState(0);
  const [selMovie, setSelMovie] = React.useState(0);
  const [catQuery, setCatQuery] = React.useState('');
  const [movieQuery, setMovieQuery] = React.useState('');

  const filteredCategories = React.useMemo(() => {
    const q = catQuery.trim().toLowerCase();
    return q ? categories.filter((c) => String(c.category_name || '').toLowerCase().includes(q)) : categories;
  }, [categories, catQuery]);

  // A non-empty query searches the whole catalog (all categories); an empty box
  // shows just the selected category's movies.
  const searching = movieQuery.trim().length > 0;
  const filteredMovies = React.useMemo(() => {
    const q = movieQuery.trim().toLowerCase();
    if (!q) return streams;
    return allStreams.filter((m) => String(m.name || '').toLowerCase().includes(q));
  }, [streams, allStreams, movieQuery]);

  // Pull the full catalog the first time the user searches, and keep the
  // selection valid as the visible list swaps between category and search.
  React.useEffect(() => {
    if (searching) void loadAllStreams();
    setSelMovie(0);
  }, [searching, movieQuery, loadAllStreams]);

  // ── Initial load ──────────────────────────────────────────────────────────────
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      const cats = await loadCategories();
      if (cancelled || !cats.length) return;
      await loadStreams(cats[0]);
      if (!cancelled) { setSelCat(0); setSelMovie(0); }
    })();
    return () => { cancelled = true; };
    // Run once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Stop playback when leaving VOD entirely.
  React.useEffect(() => () => stop(), [stop]);

  const openCategory = React.useCallback(async (cat: Category | undefined) => {
    if (!cat) return;
    await loadStreams(cat);
    setSelMovie(0);
    setFocus('movies');
  }, [loadStreams]);

  const playMovie = React.useCallback((movie: VodStream | undefined) => {
    if (!movie) return;
    play(movie);
    setBrowseOpen(false);
  }, [play]);

  // ── Keyboard handling (VOD owns the keyboard while mounted) ──────────────────────
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;

      // ── Browse open ──
      if (browseOpen) {
        // '/' jumps straight to the movie search box (searches every category).
        if (e.key === '/') { e.preventDefault(); setFocus('movies'); movieSearchRef.current?.focus(); return; }
        if (e.key === 'ArrowLeft' && focus === 'movies') { e.preventDefault(); setFocus('categories'); return; }
        if (e.key === 'ArrowRight' && focus === 'categories') { e.preventDefault(); setFocus('movies'); return; }

        if (['PageUp', 'ChannelUp', 'MediaTrackPrevious'].includes(e.key)) {
          e.preventDefault();
          if (focus === 'categories') setSelCat((v) => clamp(v - CHANNEL_ROW_JUMP, 0, Math.max(0, filteredCategories.length - 1)));
          else setSelMovie((v) => clamp(v - CHANNEL_ROW_JUMP, 0, Math.max(0, filteredMovies.length - 1)));
          return;
        }
        if (['PageDown', 'ChannelDown', 'MediaTrackNext'].includes(e.key)) {
          e.preventDefault();
          if (focus === 'categories') setSelCat((v) => clamp(v + CHANNEL_ROW_JUMP, 0, Math.max(0, filteredCategories.length - 1)));
          else setSelMovie((v) => clamp(v + CHANNEL_ROW_JUMP, 0, Math.max(0, filteredMovies.length - 1)));
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          if (focus === 'categories') setSelCat((v) => clamp(v - 1, 0, Math.max(0, filteredCategories.length - 1)));
          else setSelMovie((v) => clamp(v - 1, 0, Math.max(0, filteredMovies.length - 1)));
          return;
        }
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          if (focus === 'categories') setSelCat((v) => clamp(v + 1, 0, Math.max(0, filteredCategories.length - 1)));
          else setSelMovie((v) => clamp(v + 1, 0, Math.max(0, filteredMovies.length - 1)));
          return;
        }
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          if (focus === 'categories') void openCategory(filteredCategories[selCat]);
          else playMovie(filteredMovies[selMovie]);
          return;
        }
        if (e.key === 'Escape' || e.key === 'Backspace') {
          e.preventDefault();
          if (focus === 'movies') setFocus('categories');
          else if (state.activeId) setBrowseOpen(false); // a movie is playing — just hide the browser
          else onExit();
          return;
        }
        return;
      }

      // ── Playing (browse closed) ──
      if (e.key === 'ArrowLeft') { e.preventDefault(); seekBy(-VOD_SEEK_STEP_SECONDS); return; }
      if (e.key === 'ArrowRight') { e.preventDefault(); seekBy(VOD_SEEK_STEP_SECONDS); return; }
      if (['PageDown', 'ChannelDown', 'MediaTrackNext'].includes(e.key)) { e.preventDefault(); seekBy(-60); return; }
      if (['PageUp', 'ChannelUp', 'MediaTrackPrevious'].includes(e.key)) { e.preventDefault(); seekBy(60); return; }
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'Pause' || e.key === 'MediaPlayPause') {
        e.preventDefault();
        togglePause();
        return;
      }
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        setBrowseOpen(true);
        return;
      }
      if (e.key === 'Escape' || e.key === 'Backspace') {
        e.preventDefault();
        onExit();
      }
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [
    browseOpen, filteredCategories, filteredMovies, focus, onExit, openCategory,
    playMovie, seekBy, selCat, selMovie, state.activeId, togglePause,
  ]);

  const activeCategoryName = categories.find((c) => String(c.category_id) === activeCatId)?.category_name || 'Movies';
  const progressPct = state.duration > 0 ? clamp((state.current / state.duration) * 100, 0, 100) : 0;

  return (
    <div id="vodRoot">
      <div id="vodVideoLayer">
        <video id="vodVideo" ref={vodVideoRef} autoPlay playsInline />
      </div>

      <div id="vodBuffer" className={state.buffering ? 'show' : ''}><div className="bufferSpin" /></div>

      {/* Transport bar (visible whenever a title is loaded and the browser is closed) */}
      {state.activeId && !browseOpen && (
        <div id="vodBar">
          <div className="vodBarTop">
            <span className="vodTitle">{state.title}</span>
            <span className="vodState">{state.paused ? '❚❚ Paused' : '▶ Playing'}</span>
          </div>
          <div className="vodTrack"><div className="vodFill" style={{ width: `${progressPct}%` }} /></div>
          <div className="vodBarBottom">
            <span className="vodTime">{fmtDuration(state.current)} / {fmtDuration(state.duration)}</span>
            <span className="vodHint">← / → seek · OK play/pause · ↑ list · Back exit</span>
          </div>
          {state.error && <div className="vodError">{state.error}</div>}
        </div>
      )}

      {/* Browse overlay */}
      <div id="vodBrowse" className={browseOpen ? 'open' : ''}>
        <div className="vodBrowseHeader">
          <span className="vodBrowseTitle">Movies</span>
          <button className="vodClose" onClick={onExit}>✕ Live TV</button>
        </div>
        <div className="vodPanels">
          <div className={`panel vodCatPanel ${focus === 'categories' ? 'active' : ''}`}>
            <div className="panelHead">
              <span className="ttl">Categories</span>
              <span className="badge">{filteredCategories.length}</span>
            </div>
            <div className="searchWrap">
              <input className="sInput" placeholder="Search categories…" value={catQuery} onChange={(e) => setCatQuery(e.target.value)} />
            </div>
            <VirtualList
              items={filteredCategories}
              selectedIndex={selCat}
              active={browseOpen && focus === 'categories'}
              onPick={(i) => { setSelCat(i); void openCategory(filteredCategories[i]); }}
              render={(cat) => (
                <>
                  <div className="dot" />
                  <div className="meta"><div className="iname">{cat.category_name || 'Unnamed'}</div></div>
                </>
              )}
            />
          </div>

          <div className={`panel vodChPanel ${focus === 'movies' ? 'active' : ''}`}>
            <div className="panelHead">
              <span className="ttl">{searching ? 'Search results' : activeCategoryName}</span>
              <span className="badge">{(searching ? allLoading : loading) ? '…' : filteredMovies.length}</span>
            </div>
            <div className="searchWrap">
              <input
                ref={movieSearchRef}
                className="sInput"
                placeholder="Search all movies…  ( / )"
                value={movieQuery}
                onKeyDown={(e) => {
                  // Hand control back to list navigation without the global
                  // handler (which ignores keys typed into inputs) seeing it.
                  if (e.key === 'Enter' || e.key === 'Escape' || e.key === 'ArrowDown') {
                    e.preventDefault();
                    e.currentTarget.blur();
                  }
                }}
                onChange={(e) => setMovieQuery(e.target.value)}
              />
            </div>
            {searching && (
              <div className="vodSearchNote">
                {allLoading ? 'Loading full catalog…' : `Searching all ${allStreams.length} movies across every category`}
              </div>
            )}
            <VirtualList
              items={filteredMovies}
              selectedIndex={selMovie}
              active={browseOpen && focus === 'movies'}
              onPick={(i) => { setSelMovie(i); playMovie(filteredMovies[i]); }}
              render={(movie, index) => {
                const isPlaying = String(movie.stream_id) === state.activeId;
                return (
                  <>
                    <span className="chNum">{index + 1}</span>
                    <div className="dot" />
                    <div className="meta">
                      <div className="iname">{movie.name || 'Movie'}</div>
                      {(movie.container_extension || movie.rating) && (
                        <div className="isub">
                          {[movie.container_extension ? String(movie.container_extension).toUpperCase() : '', movie.rating ? `★ ${movie.rating}` : '']
                            .filter(Boolean).join('  ·  ')}
                        </div>
                      )}
                    </div>
                    {isPlaying && <span className="liveTag">Now</span>}
                  </>
                );
              }}
              classForIndex={(item) => (String(item.stream_id) === state.activeId ? 'playing' : '')}
            />
          </div>
        </div>
        {error && <div className="vodBrowseError">{error}</div>}
      </div>
    </div>
  );
}
