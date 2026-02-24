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

  const selectedMedia = results[selectedResult] || null;
  const selectedEp = episodes[selectedEpisode] || null;

  return (
    <div id="sidebar" className={open ? 'open' : ''}>
      <div className="netflixHeader">
        <div className="brand">RW XStream</div>
        <input
          className="sInput"
          placeholder="Search titles, series, movies…"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
        />
      </div>

      <div className="netflixHero">
        <Poster src={focus === 'episodes' && selectedEp ? selectedEp.poster : (selectedMedia?.poster || '')} alt={selectedMedia?.name || 'Poster'} />
        <div className="heroText">
          <div className="heroKicker">{focus === 'episodes' ? 'Episode selection' : 'Discover'}</div>
          <h2>{focus === 'episodes' && selectedEp ? selectedEp.title : (selectedMedia?.name || 'Search and pick a title')}</h2>
          <p>
            {focus === 'episodes'
              ? `Series: ${activeSeriesName} · ${episodes.length} episodes · OK to play`
              : `${results.length} results · use ↑↓ for fast browsing, → for episodes`}
          </p>
        </div>
      </div>

      <div className="railsWrap">
        <div className={`panel ${focus === 'results' ? 'active' : ''}`} id="catPanel">
          <div className="panelHead">
            <span className="ttl">Trending & Search Results</span>
            <span className="badge">{results.length}</span>
          </div>
          <VirtualList
            items={results}
            selectedIndex={selectedResult}
            active={open && focus === 'results'}
            onPick={onPickResult}
            itemHeight={112}
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
          <VirtualList
            items={episodes}
            selectedIndex={selectedEpisode}
            active={open && focus === 'episodes'}
            onPick={onPickEpisode}
            itemHeight={112}
            render={(episode) => {
              const key = `episode:${episode.id}`;
              const isPlaying = key === playingKey;
              return (
                <>
                  <Poster src={episode.poster} alt={episode.title || `Episode ${episode.episodeNum}`} />
                  <div className="meta">
                    <div className="iname multiline">{episode.title || `Episode ${episode.episodeNum}`}</div>
                    <div className="isub">S{episode.season} · Episode {episode.episodeNum}</div>
                  </div>
                  {isPlaying && <span className="liveTag">Playing</span>}
                </>
              );
            }}
            classForIndex={(episode) => (`episode:${episode.id}` === playingKey ? 'playing' : '')}
          />
        </div>
      </div>
    </div>
  );
}
