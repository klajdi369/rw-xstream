import React from 'react';
import { CHANNEL_PROXY_MEMORY_KEY } from '../constants';

export type ProxyMemoryEntry = { useProxy: boolean; visits: number };
export type ProxyMemoryMap = Record<string, ProxyMemoryEntry>;

export function useProxyMemory() {
  const readChannelProxyMemory = React.useCallback((): ProxyMemoryMap => {
    try {
      const parsed = JSON.parse(localStorage.getItem(CHANNEL_PROXY_MEMORY_KEY) || '{}');
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }, []);

  const writeChannelProxyMemory = React.useCallback((next: ProxyMemoryMap) => {
    localStorage.setItem(CHANNEL_PROXY_MEMORY_KEY, JSON.stringify(next));
  }, []);

  return { readChannelProxyMemory, writeChannelProxyMemory };
}
