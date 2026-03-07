import React from 'react';
import { fmtTime, decodePossiblyBase64Utf8, parseEpgTs } from '../utils';

export interface EpgEntry {
  nowTitle: string;
  nowTime: string;
  progress: number;
  next: string;
}

interface UseEpgOptions {
  apiUrl: (params: Record<string, string>) => string;
  jget: (url: string) => Promise<unknown>;
}

export function useEpg({ apiUrl, jget }: UseEpgOptions) {
  const [epg, setEpg] = React.useState<EpgEntry | null>(null);
  const epgIntervalRef = React.useRef<ReturnType<typeof setInterval> | null>(null);
  const epgRequestRef = React.useRef(0);

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

  const fetchEpg = React.useCallback(async (streamId: string | number) => {
    const requestId = epgRequestRef.current + 1;
    epgRequestRef.current = requestId;

    stopEpgRefresh();
    try {
      const data = await jget(apiUrl({ action: 'get_short_epg', stream_id: String(streamId), limit: '2' })) as Record<string, unknown>;
      if (requestId !== epgRequestRef.current) return;

      const list: unknown[] = (data?.epg_listings || data?.Epg_listings || data?.listings || []) as unknown[];
      if (!list.length) {
        setEpg(null);
        return;
      }

      const entries = (list as Record<string, unknown>[])
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
        });

        if (!next && nowSec >= cur.end - 10 && requestId === epgRequestRef.current) {
          void fetchEpg(streamId);
        }
      };

      paint();
      epgIntervalRef.current = setInterval(paint, 30000);
    } catch {
      if (requestId !== epgRequestRef.current) return;
      stopEpgRefresh();
      setEpg(null);
    }
  }, [apiUrl, jget, stopEpgRefresh]);

  React.useEffect(() => {
    return () => {
      if (epgIntervalRef.current) clearInterval(epgIntervalRef.current);
    };
  }, []);

  return { epg, fetchEpg, clearEpg, stopEpgRefresh };
}
