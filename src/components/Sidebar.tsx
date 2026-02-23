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
          <span className="ttl">Search</span>
          <span className="badge">{results.length}</span>
        </div>
        <div className="searchWrap">
          <input
            className="sInput"
            placeholder="Search series or movies…"
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
          />
        </div>
        <VirtualList
          items={results}
          selectedIndex={selectedResult}
          active={open && focus === 'results'}
          onPick={onPickResult}
          render={(item) => {
            const typeLabel = item.kind === 'series' ? 'Series' : 'Movie';
            const key = `${item.kind}:${item.id}`;
            const isPlaying = key === playingKey;
            return (
              <>
                <div className="dot" />
                <div className="meta">
                  <div className="iname">{item.name || 'Untitled'}</div>
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
          <div className="isub">Pick an episode to play</div>
        </div>
        <VirtualList
          items={episodes}
          selectedIndex={selectedEpisode}
          active={open && focus === 'episodes'}
          onPick={onPickEpisode}
          render={(episode) => {
            const key = `episode:${episode.id}`;
            const isPlaying = key === playingKey;
            return (
              <>
                <span className="chNum">S{episode.season}E{episode.episodeNum}</span>
                <div className="dot" />
                <div className="meta">
                  <div className="iname">{episode.title || `Episode ${episode.episodeNum}`}</div>
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
