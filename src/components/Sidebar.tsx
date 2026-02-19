import React from 'react';
import { Category, Channel } from '../types/player';
import { VirtualList } from './VirtualList';

type Props = {
  open: boolean;
  focus: 'categories' | 'channels';
  categories: Category[];
  channels: Channel[];
  selectedCategory: number;
  selectedChannel: number;
  categoryQuery: string;
  channelQuery: string;
  playingId: string | null;
  activeCategoryName: string;
  onCategoryQuery: (value: string) => void;
  onChannelQuery: (value: string) => void;
  onPickCategory: (index: number) => void;
  onPickChannel: (index: number) => void;
};

export function Sidebar(props: Props) {
  const {
    open, focus, categories, channels, selectedCategory, selectedChannel,
    categoryQuery, channelQuery, playingId, activeCategoryName,
    onCategoryQuery, onChannelQuery, onPickCategory, onPickChannel,
  } = props;

  return (
    <div id="sidebar" className={open ? 'open' : ''}>
      <div className={`panel ${focus === 'categories' ? 'active' : ''}`} id="catPanel">
        <div className="panelHead">
          <span className="ttl">Categories</span>
          <span className="badge">{categories.length}</span>
        </div>
        <div className="searchWrap">
          <input
            className="sInput"
            placeholder="Search categories…"
            value={categoryQuery}
            onChange={(e) => onCategoryQuery(e.target.value)}
          />
        </div>
        <VirtualList
          items={categories}
          selectedIndex={selectedCategory}
          active={open && focus === 'categories'}
          onPick={onPickCategory}
          render={(cat) => (
            <>
              <div className="dot" />
              <div className="meta">
                <div className="iname">{cat.category_name || 'Unnamed'}</div>
              </div>
            </>
          )}
        />
      </div>
      <div className={`panel ${focus === 'channels' ? 'active' : ''}`} id="chPanel">
        <div className="panelHead">
          <span className="ttl">{activeCategoryName || 'Channels'}</span>
          <span className="badge">{channels.length}</span>
        </div>
        <div className="searchWrap">
          <input
            className="sInput"
            placeholder="Search channels…"
            value={channelQuery}
            onChange={(e) => onChannelQuery(e.target.value)}
          />
        </div>
        <VirtualList
          items={channels}
          selectedIndex={selectedChannel}
          active={open && focus === 'channels'}
          onPick={onPickChannel}
          render={(ch, index) => {
            const isPlaying = String(ch.stream_id) === playingId;
            return (
              <>
                <span className="chNum">{index + 1}</span>
                <div className="dot" />
                <div className="meta">
                  <div className="iname">{ch.name || 'Channel'}</div>
                </div>
                {isPlaying && <span className="liveTag">Live</span>}
              </>
            );
          }}
          classForIndex={(item) => (String(item.stream_id) === playingId ? 'playing' : '')}
        />
      </div>
    </div>
  );
}
