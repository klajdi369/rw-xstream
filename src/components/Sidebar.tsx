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
  onCategoryQuery: (value: string) => void;
  onChannelQuery: (value: string) => void;
  onPickCategory: (index: number) => void;
  onPickChannel: (index: number) => void;
};

export function Sidebar(props: Props) {
  const {
    open, focus, categories, channels, selectedCategory, selectedChannel,
    categoryQuery, channelQuery, playingId,
    onCategoryQuery, onChannelQuery, onPickCategory, onPickChannel,
  } = props;

  return (
    <div id="sidebar" className={open ? 'open' : ''}>
      <div className={`panel ${focus === 'categories' ? 'active' : ''}`} id="catPanel">
        <div className="panelHead"><span className="ttl">Categories</span><span className="badge">{categories.length}</span></div>
        <div className="searchWrap"><input className="sInput" placeholder="Search…" value={categoryQuery} onChange={(e) => onCategoryQuery(e.target.value)} /></div>
        <VirtualList
          items={categories}
          selectedIndex={selectedCategory}
          onPick={onPickCategory}
          render={(cat) => (
            <>
              <div className="dot" />
              <div className="meta"><div className="iname">{cat.category_name || 'Unnamed'}</div></div>
            </>
          )}
        />
      </div>
      <div className={`panel ${focus === 'channels' ? 'active' : ''}`} id="chPanel">
        <div className="panelHead"><span className="ttl">Channels</span><span className="badge">{channels.length}</span></div>
        <div className="searchWrap"><input className="sInput" placeholder="Search…" value={channelQuery} onChange={(e) => onChannelQuery(e.target.value)} /></div>
        <VirtualList
          items={channels}
          selectedIndex={selectedChannel}
          onPick={onPickChannel}
          render={(ch) => (
            <>
              <div className="dot" />
              <div className="meta"><div className="iname">{ch.name || 'Channel'}</div><div className="isub">ID {String(ch.stream_id)}</div></div>
            </>
          )}
          classForIndex={(item) => (String(item.stream_id) === playingId ? 'playing' : '')}
        />
      </div>
    </div>
  );
}
