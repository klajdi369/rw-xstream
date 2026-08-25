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
  backendBaseUrl: string;
}

interface Programme {
  title: string;
  start: number;
  end: number;
}

interface EpgResponse {
  matched?: boolean;
  programmes?: { title?: unknown; start?: unknown; stop?: unknown }[];
}

const EXTERNAL_EPG_URL = 'https://www.open-epg.com/files/albania1.xml';
// Guides move slowly; the server holds its own cache, this one just keeps
// rapid zapping between the same few channels off the network.
const EXTERNAL_EPG_TTL_MS = 10 * 60 * 1000;
// A set-top box stays up for weeks; don't accumulate an entry per channel ever
// visited. Comfortably more than anyone zaps between in one TTL.
const EXTERNAL_EPG_MAX_CACHED = 64;

/** Identifies a cached lookup; both identifiers take part, neither is trusted to be unique alone. */
function cacheKeyFor(epgChannelId?: string | null, channelName?: string) {
  return JSON.stringify([String(epgChannelId ?? '').trim(), String(channelName ?? '').trim()]);
}

export function useEpg({ apiUrl, jget, backendBaseUrl }: UseEpgOptions) {
  const [epg, setEpg] = React.useState<EpgEntry | null>(null);
  const epgIntervalRef = React.useRef<ReturnType<typeof setInterval> | null>(null);
  const epgRequestRef = React.useRef(0);
  const externalCacheRef = React.useRef(new Map<string, { fetchedAt: number; programmes: Programme[] }>());
  const externalInFlightRef = React.useRef(new Map<string, Promise<Programme[]>>());

  /**
   * Ask the backend for this channel's programmes. The XMLTV feed is fetched,
   * parsed and matched server-side, so the browser only ever sees the handful
   * of entries around now.
   */
  const loadExternalEntries = React.useCallback(async (epgChannelId?: string | null, channelName?: string): Promise<Programme[]> => {
    const channel = String(epgChannelId ?? '').trim();
    const name = String(channelName ?? '').trim();
    if (!channel && !name) return [];

    const cacheKey = cacheKeyFor(channel, name);
    const cached = externalCacheRef.current.get(cacheKey);
    if (cached && (Date.now() - cached.fetchedAt) < EXTERNAL_EPG_TTL_MS) return cached.programmes;

    const inFlight = externalInFlightRef.current.get(cacheKey);
    if (inFlight) return inFlight;

    const request = (async (): Promise<Programme[]> => {
      try {
        const query = new URLSearchParams({ url: EXTERNAL_EPG_URL, channel, name });
        const res = await fetch(`${backendBaseUrl}/epg?${query}`, { cache: 'no-store' });
        if (!res.ok) throw new Error(`EPG HTTP ${res.status}`);

        const data = await res.json() as EpgResponse;
        const programmes = (data.programmes || [])
          .map((entry) => ({
            title: String(entry.title ?? ''),
            start: parseEpgTs(entry.start),
            end: parseEpgTs(entry.stop),
          }))
          .filter((entry) => entry.title && entry.start > 0 && entry.end > entry.start)
          .sort((a, b) => a.start - b.start);

        const cache = externalCacheRef.current;
        cache.delete(cacheKey);
        cache.set(cacheKey, { fetchedAt: Date.now(), programmes });
        // Map preserves insertion order, so the first key is the oldest write.
        while (cache.size > EXTERNAL_EPG_MAX_CACHED) {
          const oldest = cache.keys().next();
          if (oldest.done) break;
          cache.delete(oldest.value);
        }
        return programmes;
      } catch {
        // Leave the cache alone so a previous good answer survives a blip; the
        // caller falls back to the provider's own guide.
        return cached?.programmes ?? [];
      } finally {
        externalInFlightRef.current.delete(cacheKey);
      }
    })();

    externalInFlightRef.current.set(cacheKey, request);
    return request;
  }, [backendBaseUrl]);

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
      let entries = await loadExternalEntries(epgChannelId, channelName);
      if (requestId !== epgRequestRef.current) return;

      const source: 'external' | 'default' = entries.length ? 'external' : 'default';

      if (!entries.length) {
        const data = await jget(apiUrl({ action: 'get_short_epg', stream_id: String(streamId), limit: '2' })) as Record<string, unknown>;
        if (requestId !== epgRequestRef.current) return;

        const list: unknown[] = (data?.epg_listings || data?.Epg_listings || data?.listings || []) as unknown[];
        entries = (list as Record<string, unknown>[])
          .map((e) => {
            const start = parseEpgTs(e.start_timestamp ?? e.start ?? e.start_ts ?? e.begin ?? e.from);
            const end = parseEpgTs(e.stop_timestamp ?? e.end_timestamp ?? e.end ?? e.stop ?? e.to);
            return {
              // Xtream panels commonly base64-encode these; XMLTV titles are
              // plain text and must not go through the same decoder.
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
          // Out of entries — drop the cached window so the refetch gets a
          // fresh one rather than replaying the same exhausted list.
          externalCacheRef.current.delete(cacheKeyFor(epgChannelId, channelName));
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
  }, [apiUrl, jget, loadExternalEntries, stopEpgRefresh]);

  React.useEffect(() => {
    return () => {
      if (epgIntervalRef.current) clearInterval(epgIntervalRef.current);
    };
  }, []);

  return { epg, fetchEpg, clearEpg, stopEpgRefresh };
}
