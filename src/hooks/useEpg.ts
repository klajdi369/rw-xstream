import React from 'react';
import { fmtTime, decodePossiblyBase64Utf8, parseEpgTs } from '../utils';

export interface EpgEntry {
  nowTitle: string;
  nowTime: string;
  progress: number;
  next: string;
  source: 'external' | 'default';
}

interface UseEpgOptions {
  apiUrl: (params: Record<string, string>) => string;
  jget: (url: string) => Promise<unknown>;
}

export function useEpg({ apiUrl, jget }: UseEpgOptions) {
  const [epg, setEpg] = React.useState<EpgEntry | null>(null);
  const epgIntervalRef = React.useRef<ReturnType<typeof setInterval> | null>(null);
  const epgRequestRef = React.useRef(0);
  const externalEpgRef = React.useRef<Map<string, { title: string; start: number; end: number }[]> | null>(null);
  const externalEpgLoadRef = React.useRef<Promise<Map<string, { title: string; start: number; end: number }[]> | null> | null>(null);

  const normalizeChannelKey = React.useCallback((value: unknown): string => {
    return String(value || '')
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '');
  }, []);

  const loadExternalEpg = React.useCallback(async () => {
    if (externalEpgRef.current) return externalEpgRef.current;
    if (externalEpgLoadRef.current) return externalEpgLoadRef.current;

    externalEpgLoadRef.current = (async () => {
      try {
        const res = await fetch('https://www.open-epg.com/files/albania1.xml');
        if (!res.ok) throw new Error(`EPG XML HTTP ${res.status}`);
        const xml = await res.text();
        const doc = new DOMParser().parseFromString(xml, 'application/xml');
        if (doc.querySelector('parsererror')) throw new Error('Invalid XMLTV payload');

        const byChannel = new Map<string, { title: string; start: number; end: number }[]>();
        const programmes = Array.from(doc.querySelectorAll('programme'));
        for (const p of programmes) {
          const channel = p.getAttribute('channel') || '';
          const key = normalizeChannelKey(channel);
          if (!key) continue;

          const start = parseEpgTs(p.getAttribute('start'));
          const end = parseEpgTs(p.getAttribute('stop'));
          if (!(start > 0 && end > start)) continue;

          const title = decodePossiblyBase64Utf8(p.querySelector('title')?.textContent || '');
          const list = byChannel.get(key) || [];
          list.push({ title, start, end });
          byChannel.set(key, list);
        }

        byChannel.forEach((list, key) => {
          list.sort((a, b) => a.start - b.start);
          byChannel.set(key, list);
        });

        externalEpgRef.current = byChannel;
        return byChannel;
      } catch {
        externalEpgRef.current = null;
        return null;
      } finally {
        externalEpgLoadRef.current = null;
      }
    })();

    return externalEpgLoadRef.current;
  }, [normalizeChannelKey]);

  const stopEpgRefresh = React.useCallback(() => {
    if (epgIntervalRef.current) clearInterval(epgIntervalRef.current);
    epgIntervalRef.current = null;
  }, []);

  const clearEpg = React.useCallback(() => {
    epgRequestRef.current += 1;
    if (epgIntervalRef.current) clearInterval(epgIntervalRef.current);
    epgIntervalRef.current = null;
    setEpg(null);
  }, []);

  const fetchEpg = React.useCallback(async (streamId: string | number, epgChannelId?: string | null, channelName?: string) => {
    const requestId = epgRequestRef.current + 1;
    epgRequestRef.current = requestId;

    stopEpgRefresh();
    try {
      const externalEpg = await loadExternalEpg();
      if (requestId !== epgRequestRef.current) return;

      const keyCandidates = [
        normalizeChannelKey(epgChannelId),
        normalizeChannelKey(channelName),
      ].filter(Boolean);

      const externalEntries = keyCandidates
        .map((k) => externalEpg?.get(k) || [])
        .find((list) => list.length) || [];

      let entries = externalEntries;
      let source: 'external' | 'default' = entries.length ? 'external' : 'default';

      if (!entries.length) {
        const data = await jget(apiUrl({ action: 'get_short_epg', stream_id: String(streamId), limit: '2' })) as Record<string, unknown>;
        if (requestId !== epgRequestRef.current) return;

        const list: unknown[] = (data?.epg_listings || data?.Epg_listings || data?.listings || []) as unknown[];
        entries = (list as Record<string, unknown>[])
          .map((e) => {
            const start = parseEpgTs(e.start_timestamp ?? e.start ?? e.start_ts ?? e.begin ?? e.from);
            const end = parseEpgTs(e.stop_timestamp ?? e.end_timestamp ?? e.end ?? e.stop ?? e.to);
            return {
              title: decodePossiblyBase64Utf8(e.title ?? e.name ?? e.programme_title ?? ''),
              start,
              end,
            };
          })
          .filter((e) => e.start > 0 && e.end > e.start)
          .sort((a, b) => a.start - b.start);
      }

      if (!entries.length) {
        setEpg(null);
        return;
      }

      const paint = () => {
        if (requestId !== epgRequestRef.current) return;
        const nowSec = Date.now() / 1000;

        let curIndex = entries.findIndex((e) => e.start <= nowSec && e.end > nowSec);
        if (curIndex < 0) {
          const firstFutureIndex = entries.findIndex((e) => e.start > nowSec);
          curIndex = firstFutureIndex > 0 ? firstFutureIndex - 1 : entries.length - 1;
        }

        const cur = entries[curIndex];
        if (!cur) return;

        const next = entries[curIndex + 1] || null;
        const dur = Math.max(1, cur.end - cur.start);
        const progress = Math.min(100, Math.max(0, Math.round(((nowSec - cur.start) / dur) * 100)));

        if (requestId !== epgRequestRef.current) return;

        setEpg({
          nowTitle: cur.title,
          nowTime: `${fmtTime(cur.start)} – ${fmtTime(cur.end)}`,
          progress,
          next: next ? `Next  ${fmtTime(next.start)}  ${next.title}` : '',
          source,
        });

        if (!next && nowSec >= cur.end - 10 && requestId === epgRequestRef.current) {
          void fetchEpg(streamId, epgChannelId, channelName);
        }
      };

      paint();
      epgIntervalRef.current = setInterval(paint, 30000);
    } catch {
      if (requestId !== epgRequestRef.current) return;
      stopEpgRefresh();
      setEpg(null);
    }
  }, [apiUrl, jget, loadExternalEpg, normalizeChannelKey, stopEpgRefresh]);

  React.useEffect(() => {
    return () => {
      if (epgIntervalRef.current) clearInterval(epgIntervalRef.current);
    };
  }, []);

  return { epg, fetchEpg, clearEpg, stopEpgRefresh };
}
