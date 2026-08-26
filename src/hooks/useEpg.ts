import React from 'react';
import { fmtTime, decodePossiblyBase64Utf8, parseEpgTs } from '../utils';

export type EpgSource = 'external' | 'default' | 'none';

export interface EpgProgramme {
  title: string;
  start: number;
  end: number;
  description?: string;
  category?: string;
}

export interface EpgSchedule {
  programmes: EpgProgramme[];
  source: EpgSource;
  stale: boolean;
  updatedAt: number;
  error?: string;
}

export interface EpgEntry {
  nowTitle: string;
  nowTime: string;
  progress: number;
  next: string;
  source: Exclude<EpgSource, 'none'>;
}

interface UseEpgOptions {
  apiUrl: (params: Record<string, string>) => string;
  jget: (url: string) => Promise<unknown>;
  backendBaseUrl: string;
  epgUrl: string;
}

interface ExternalEpgResponse {
  matched?: boolean;
  stale?: boolean;
  error?: string;
  programmes?: {
    title?: unknown;
    start?: unknown;
    stop?: unknown;
    description?: unknown;
    category?: unknown;
  }[];
}

interface ExternalResult {
  programmes: EpgProgramme[];
  matched: boolean;
  stale: boolean;
  error?: string;
}

const EPG_TTL_MS = 10 * 60 * 1000;
// A set-top box can stay up for weeks. Bound both caches so channel surfing
// cannot retain every schedule ever visited for the lifetime of the page.
const EPG_MAX_CACHED_CHANNELS = 160;

function externalCacheKey(epgUrl: string, epgChannelId?: string | null, channelName?: string) {
  return JSON.stringify([epgUrl.trim(), String(epgChannelId ?? '').trim(), String(channelName ?? '').trim()]);
}

function scheduleCacheKey(
  epgUrl: string,
  providerGeneration: number,
  streamId: string | number,
  epgChannelId?: string | null,
  channelName?: string,
) {
  return JSON.stringify([
    epgUrl.trim(),
    providerGeneration,
    String(streamId),
    String(epgChannelId ?? '').trim(),
    String(channelName ?? '').trim(),
  ]);
}

function keepNewestEntries<T>(cache: Map<string, T>) {
  while (cache.size > EPG_MAX_CACHED_CHANNELS) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

function parseExternalProgrammes(data: ExternalEpgResponse): EpgProgramme[] {
  return (data.programmes || [])
    .map((entry) => ({
      title: String(entry.title ?? '').trim(),
      start: parseEpgTs(entry.start),
      end: parseEpgTs(entry.stop),
      description: String(entry.description ?? '').trim() || undefined,
      category: String(entry.category ?? '').trim() || undefined,
    }))
    .filter((entry) => entry.title && entry.start > 0 && entry.end > entry.start)
    .sort((a, b) => a.start - b.start);
}

function parseProviderProgrammes(data: unknown): EpgProgramme[] {
  const record = (data && typeof data === 'object') ? data as Record<string, unknown> : {};
  const list = (record.epg_listings || record.Epg_listings || record.listings || []) as unknown[];

  return (Array.isArray(list) ? list : [])
    .map((raw) => {
      const entry = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {};
      const start = parseEpgTs(entry.start_timestamp ?? entry.start ?? entry.start_ts ?? entry.begin ?? entry.from);
      const end = parseEpgTs(entry.stop_timestamp ?? entry.end_timestamp ?? entry.end ?? entry.stop ?? entry.to);
      return {
        // Xtream panels commonly base64-encode text fields. XMLTV text is
        // already decoded by the server and never passes through this path.
        title: decodePossiblyBase64Utf8(entry.title ?? entry.name ?? entry.programme_title ?? '').trim(),
        start,
        end,
        description: decodePossiblyBase64Utf8(entry.description ?? entry.desc ?? '').trim() || undefined,
        category: decodePossiblyBase64Utf8(entry.category ?? '').trim() || undefined,
      };
    })
    .filter((entry) => entry.title && entry.start > 0 && entry.end > entry.start)
    .sort((a, b) => a.start - b.start);
}

export function useEpg({ apiUrl, jget, backendBaseUrl, epgUrl }: UseEpgOptions) {
  const [epg, setEpg] = React.useState<EpgEntry | null>(null);
  const epgIntervalRef = React.useRef<ReturnType<typeof setInterval> | null>(null);
  const epgRequestRef = React.useRef(0);
  const externalCacheRef = React.useRef(new Map<string, { fetchedAt: number; result: ExternalResult }>());
  const externalInFlightRef = React.useRef(new Map<string, Promise<ExternalResult>>());
  const scheduleCacheRef = React.useRef(new Map<string, EpgSchedule>());
  const scheduleInFlightRef = React.useRef(new Map<string, Promise<EpgSchedule>>());
  const providerGenerationRef = React.useRef(0);
  const previousApiUrlRef = React.useRef(apiUrl);
  if (previousApiUrlRef.current !== apiUrl) {
    previousApiUrlRef.current = apiUrl;
    providerGenerationRef.current += 1;
  }

  const loadExternalEntries = React.useCallback(async (
    epgChannelId?: string | null,
    channelName?: string,
    force = false,
  ): Promise<ExternalResult> => {
    const channel = String(epgChannelId ?? '').trim();
    const name = String(channelName ?? '').trim();
    const guideUrl = epgUrl.trim();
    if (!guideUrl || (!channel && !name)) return { programmes: [], matched: false, stale: false };

    const key = externalCacheKey(guideUrl, channel, name);
    const cached = externalCacheRef.current.get(key);
    if (!force && cached && Date.now() - cached.fetchedAt < EPG_TTL_MS) return cached.result;

    const inFlight = externalInFlightRef.current.get(key);
    if (inFlight) return inFlight;

    const request = (async (): Promise<ExternalResult> => {
      try {
        const query = new URLSearchParams({ url: guideUrl, channel, name });
        const res = await fetch(`${backendBaseUrl}/epg?${query}`, { cache: 'no-store' });
        const data = await res.json().catch(() => ({})) as ExternalEpgResponse;
        if (!res.ok) throw new Error(data.error || `EPG HTTP ${res.status}`);

        const result: ExternalResult = {
          programmes: parseExternalProgrammes(data),
          matched: data.matched === true,
          stale: data.stale === true,
        };
        const cache = externalCacheRef.current;
        cache.delete(key);
        cache.set(key, { fetchedAt: Date.now(), result });
        keepNewestEntries(cache);
        return result;
      } catch (error) {
        // A stale good answer is much more useful than a blank guide during a
        // temporary feed outage. Mark it stale so the full guide can say so.
        if (cached) return { ...cached.result, stale: true };
        return {
          programmes: [],
          matched: false,
          stale: false,
          error: (error as Error)?.message || 'External guide unavailable',
        };
      } finally {
        externalInFlightRef.current.delete(key);
      }
    })();

    externalInFlightRef.current.set(key, request);
    return request;
  }, [backendBaseUrl, epgUrl]);

  /** Load a complete schedule for the guide and for the compact now/next HUD. */
  const loadSchedule = React.useCallback(async (
    streamId: string | number,
    epgChannelId?: string | null,
    channelName?: string,
    force = false,
  ): Promise<EpgSchedule> => {
    const key = scheduleCacheKey(
      epgUrl,
      providerGenerationRef.current,
      streamId,
      epgChannelId,
      channelName,
    );
    const cached = scheduleCacheRef.current.get(key);
    if (!force && cached && Date.now() - cached.updatedAt < EPG_TTL_MS) return cached;

    const inFlight = scheduleInFlightRef.current.get(key);
    if (inFlight) return inFlight;

    const request = (async (): Promise<EpgSchedule> => {
      const external = await loadExternalEntries(epgChannelId, channelName, force);
      let schedule: EpgSchedule;

      if (external.programmes.length) {
        schedule = {
          programmes: external.programmes,
          source: 'external',
          stale: external.stale,
          updatedAt: Date.now(),
          error: external.error,
        };
      } else {
        try {
          // A larger limit makes the provider fallback useful as an actual
          // guide instead of restricting it to the two HUD entries.
          const data = await jget(apiUrl({
            action: 'get_short_epg',
            stream_id: String(streamId),
            limit: '64',
          }));
          const programmes = parseProviderProgrammes(data);
          schedule = {
            programmes,
            source: programmes.length ? 'default' : 'none',
            stale: false,
            updatedAt: Date.now(),
            error: programmes.length ? undefined : external.error,
          };
        } catch (error) {
          schedule = {
            programmes: [],
            source: 'none',
            stale: false,
            updatedAt: Date.now(),
            error: external.error || (error as Error)?.message || 'Guide unavailable',
          };
        }
      }

      const cache = scheduleCacheRef.current;
      cache.delete(key);
      cache.set(key, schedule);
      keepNewestEntries(cache);
      return schedule;
    })().finally(() => scheduleInFlightRef.current.delete(key));

    scheduleInFlightRef.current.set(key, request);
    return request;
  }, [apiUrl, epgUrl, jget, loadExternalEntries]);

  const stopEpgRefresh = React.useCallback(() => {
    if (epgIntervalRef.current) clearInterval(epgIntervalRef.current);
    epgIntervalRef.current = null;
  }, []);

  const clearEpg = React.useCallback(() => {
    epgRequestRef.current += 1;
    stopEpgRefresh();
    setEpg(null);
  }, [stopEpgRefresh]);

  const fetchEpg = React.useCallback(async (
    streamId: string | number,
    epgChannelId?: string | null,
    channelName?: string,
  ) => {
    const requestId = epgRequestRef.current + 1;
    epgRequestRef.current = requestId;
    stopEpgRefresh();

    try {
      const schedule = await loadSchedule(streamId, epgChannelId, channelName);
      if (requestId !== epgRequestRef.current) return;

      let activeSchedule = schedule;
      let entries = schedule.programmes;
      let refreshPending = false;
      if (!entries.length || schedule.source === 'none') {
        setEpg(null);
        return;
      }

      const paint = () => {
        if (requestId !== epgRequestRef.current) return;
        if (!entries.length || activeSchedule.source === 'none') {
          setEpg(null);
          return;
        }
        const nowSec = Date.now() / 1000;
        let currentIndex = entries.findIndex((entry) => entry.start <= nowSec && entry.end > nowSec);

        if (currentIndex < 0) {
          const firstFuture = entries.findIndex((entry) => entry.start > nowSec);
          currentIndex = firstFuture >= 0 ? firstFuture : entries.length - 1;
        }

        const current = entries[currentIndex];
        if (!current) return;
        const next = entries[currentIndex + 1] || null;
        const duration = Math.max(1, current.end - current.start);
        const progress = Math.min(100, Math.max(0, Math.round(((nowSec - current.start) / duration) * 100)));
        const epgSource: Exclude<EpgSource, 'none'> = activeSchedule.source;

        setEpg({
          nowTitle: current.title,
          nowTime: `${fmtTime(current.start)} – ${fmtTime(current.end)}`,
          progress,
          next: next ? `Next  ${fmtTime(next.start)}  ${next.title}` : '',
          source: epgSource,
        });

        // Refresh a long-running player's schedule in place. This keeps both
        // the HUD and its underlying cache current without interrupting video.
        if (!refreshPending && Date.now() - activeSchedule.updatedAt >= EPG_TTL_MS) {
          refreshPending = true;
          void loadSchedule(streamId, epgChannelId, channelName, true)
            .then((fresh) => {
              if (requestId !== epgRequestRef.current) return;
              activeSchedule = fresh;
              entries = fresh.programmes;
              paint();
            })
            .finally(() => { refreshPending = false; });
        }
      };

      paint();
      epgIntervalRef.current = setInterval(paint, 30_000);
    } catch {
      if (requestId !== epgRequestRef.current) return;
      stopEpgRefresh();
      setEpg(null);
    }
  }, [loadSchedule, stopEpgRefresh]);

  React.useEffect(() => () => stopEpgRefresh(), [stopEpgRefresh]);

  return { epg, fetchEpg, clearEpg, stopEpgRefresh, loadSchedule };
}
