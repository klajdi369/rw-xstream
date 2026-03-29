import React from 'react';
import { CHANNEL_ORDER_KEY, CHANNEL_ORDER_MODE_KEY } from '../constants';
import { clamp } from '../utils';
import { Channel } from '../types/player';

export type ChannelOrderMap = Record<string, Record<string, number>>;

export function useChannelOrder() {
  const [channelOrderMap, setChannelOrderMap] = React.useState<ChannelOrderMap>({});
  const [customOrderInList, setCustomOrderInList] = React.useState(true);

  const readChannelOrderMap = React.useCallback((): ChannelOrderMap => {
    try {
      const parsed = JSON.parse(localStorage.getItem(CHANNEL_ORDER_KEY) || '{}');
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }, []);

  const writeChannelOrderMap = React.useCallback((next: ChannelOrderMap) => {
    localStorage.setItem(CHANNEL_ORDER_KEY, JSON.stringify(next));
    setChannelOrderMap(next);
  }, []);

  const readChannelOrderMode = React.useCallback((): boolean => {
    try {
      const raw = localStorage.getItem(CHANNEL_ORDER_MODE_KEY);
      if (raw == null) return true;
      return raw !== 'default';
    } catch {
      return true;
    }
  }, []);

  const writeChannelOrderMode = React.useCallback((isCustom: boolean) => {
    localStorage.setItem(CHANNEL_ORDER_MODE_KEY, isCustom ? 'custom' : 'default');
    setCustomOrderInList(isCustom);
  }, []);

  const sortWithCustomOrder = React.useCallback(
    (list: Channel[], catId: string, enabled: boolean): Channel[] => {
      if (!enabled) return list;
      const orders = channelOrderMap[catId] || {};
      const total = list.length;
      if (!total) return list;

      const withMeta = list.map((ch, index) => {
        const raw = Number(orders[String(ch.stream_id)]);
        const hasOrder = Number.isFinite(raw) && raw > 0;
        const order = hasOrder ? clamp(Math.floor(raw), 1, total) : 0;
        return { ch, index, hasOrder, order };
      });

      const pinned = withMeta
        .filter((item) => item.hasOrder)
        .sort((a, b) => a.order - b.order || a.index - b.index);

      const unpinned = withMeta.filter((item) => !item.hasOrder);
      const result: Channel[] = new Array(total);
      const used = new Set<number>();

      for (const item of pinned) {
        let pos = item.order - 1;
        while (pos < total && used.has(pos)) pos += 1;
        if (pos >= total) {
          pos = 0;
          while (pos < total && used.has(pos)) pos += 1;
        }
        if (pos >= total) break;
        result[pos] = item.ch;
        used.add(pos);
      }

      let u = 0;
      for (let i = 0; i < total; i += 1) {
        if (used.has(i)) continue;
        result[i] = unpinned[u].ch;
        u += 1;
      }

      return result;
    },
    [channelOrderMap],
  );

  const init = React.useCallback(() => {
    setChannelOrderMap(readChannelOrderMap());
    setCustomOrderInList(readChannelOrderMode());
  }, [readChannelOrderMap, readChannelOrderMode]);

  return {
    channelOrderMap,
    customOrderInList,
    readChannelOrderMap,
    writeChannelOrderMap,
    readChannelOrderMode,
    writeChannelOrderMode,
    sortWithCustomOrder,
    init,
  };
}
