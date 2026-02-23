import React from 'react';
import { MediaResult, SeriesEpisode } from '../types/player';
import { VirtualList } from './VirtualList';

type Props = {
  open: boolean;
  focus: 'results' | 'episodes';
  query: string;
  results: MediaResult[];
  episodes: SeriesEpisode[];
  selectedResult: number;
  selectedEpisode: number;
  playingKey: string | null;
  activeSeriesName: string;
  onQueryChange: (value: string) => void;
  onPickResult: (index: number) => void;
  onPickEpisode: (index: number) => void;
};

function Poster({ src, alt }: { src: string; alt: string }) {
  if (!src) return <div className="thumb fallback" aria-hidden="true">🎬</div>;
  return <img className="thumb" src={src} alt={alt} loading="lazy" decoding="async" referrerPolicy="no-referrer" />;
}

export function Sidebar(props: Props) {
  const {
    open,
    focus,
    query,
    results,
    episodes,
    selectedResult,
    selectedEpisode,
    playingKey,
    activeSeriesName,
    onQueryChange,
    onPickResult,
    onPickEpisode,
  } = props;

  return (
    <div id="sidebar" className={open ? 'open' : ''}>
      <div className={`panel ${focus === 'results' ? 'active' : ''}`} id="catPanel">
        <div className="panelHead">
          <span className="ttl">Search VOD</span>
          <span className="badge">{results.length}</span>
        </div>
        <div className="searchWrap">
          <input
            className="sInput"
            placeholder="Type to search movies/series…"
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
          />
          <div className="isub">Remote: type letters, ↑↓ navigate, OK select, → episodes</div>
        </div>
        <VirtualList
          items={results}
          selectedIndex={selectedResult}
          active={open && focus === 'results'}
          onPick={onPickResult}
          itemHeight={92}
          render={(item) => {
            const typeLabel = item.kind === 'series' ? 'Series' : 'Movie';
            const key = `${item.kind}:${item.id}`;
            const isPlaying = key === playingKey;
            return (
              <>
                <Poster src={item.poster} alt={item.name || typeLabel} />
                <div className="meta">
                  <div className="iname multiline">{item.name || 'Untitled'}</div>
                  <div className="isub">{typeLabel}</div>
                </div>
                {isPlaying && <span className="liveTag">Playing</span>}
              </>
            );
          }}
          classForIndex={(item) => (`${item.kind}:${item.id}` === playingKey ? 'playing' : '')}
        />
      </div>

      <div className={`panel ${focus === 'episodes' ? 'active' : ''}`} id="chPanel">
        <div className="panelHead">
          <span className="ttl">{activeSeriesName || 'Episodes'}</span>
          <span className="badge">{episodes.length}</span>
        </div>
        <div className="searchWrap">
          <div className="isub">Remote: ↑↓ navigate, OK play, ← back to results</div>
        </div>
        <VirtualList
          items={episodes}
          selectedIndex={selectedEpisode}
          active={open && focus === 'episodes'}
          onPick={onPickEpisode}
          itemHeight={96}
          render={(episode) => {
            const key = `episode:${episode.id}`;
            const isPlaying = key === playingKey;
            return (
              <>
                <Poster src={episode.poster} alt={episode.title || `Episode ${episode.episodeNum}`} />
                <span className="chNum">S{episode.season}E{episode.episodeNum}</span>
                <div className="meta">
                  <div className="iname multiline">{episode.title || `Episode ${episode.episodeNum}`}</div>
                </div>
                {isPlaying && <span className="liveTag">Playing</span>}
              </>
            );
          }}
          classForIndex={(episode) => (`episode:${episode.id}` === playingKey ? 'playing' : '')}
        />
      </div>
    </div>
  );
}
