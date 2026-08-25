import React from 'react';
import { Category, Channel } from '../types/player';
import { VirtualList } from './VirtualList';

type Props = {
  open: boolean;
  focus: 'categories' | 'channels';
  categories: Category[];
  showCategories?: boolean;
  channels: Channel[];
  selectedCategory: number;
  selectedChannel: number;
  categoryQuery: string;
  channelQuery: string;
  playingId: string | null;
  activeCategoryName: string;
  channelOrderModeLabel: string;
  categorySearchRef?: React.RefObject<HTMLInputElement>;
  channelSearchRef?: React.RefObject<HTMLInputElement>;
  onSearchNav?: (dir: 'up' | 'down' | 'left' | 'right') => void;
  onCategoryQuery: (value: string) => void;
  onChannelQuery: (value: string) => void;
  onPickCategory: (index: number) => void;
  onPickChannel: (index: number) => void;
};

export function Sidebar(props: Props) {
  const {
    open, focus, categories, channels, selectedCategory, selectedChannel, showCategories = true,
    categoryQuery, channelQuery, playingId, activeCategoryName, channelOrderModeLabel,
    categorySearchRef, channelSearchRef, onSearchNav,
    onCategoryQuery, onChannelQuery, onPickCategory, onPickChannel,
  } = props;

  // Leave the search field back to list/panel navigation. Arrow keys blur the
  // field and hand the intended direction to the parent — so from search you
  // can drop into the list (↓) or jump between the category/channel panels
  // (←/→) in a single press, instead of getting stuck typing.
  const searchFieldKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === 'Escape') {
      e.preventDefault();
      e.currentTarget.blur();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      e.currentTarget.blur();
      const dir = e.key === 'ArrowDown' ? 'down' : e.key === 'ArrowUp' ? 'up' : e.key === 'ArrowLeft' ? 'left' : 'right';
      onSearchNav?.(dir);
    }
  };

  return (
    <div id="sidebar" className={open ? 'open' : ''}>
      {showCategories && (
        <div className={`panel ${focus === 'categories' ? 'active' : ''}`} id="catPanel">
          <div className="panelHead">
            <span className="ttl">Categories</span>
            <span className="badge">{categories.length}</span>
          </div>
          <div className="searchWrap">
            <input
              ref={categorySearchRef}
              className="sInput"
              placeholder="Search categories…"
              value={categoryQuery}
              onKeyDown={searchFieldKey}
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
      )}
      <div className={`panel ${focus === 'channels' ? 'active' : ''}`} id="chPanel">
        <div className="panelHead">
          <span className="ttl">{activeCategoryName || 'Channels'}</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="badge">{channelOrderModeLabel}</span>
            <span className="badge">{channels.length}</span>
          </div>
        </div>
        <div className="searchWrap">
          <input
            ref={channelSearchRef}
            className="sInput"
            placeholder="Search channels…"
            value={channelQuery}
            onKeyDown={searchFieldKey}
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
