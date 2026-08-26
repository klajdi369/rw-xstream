import React from 'react';
import { BoundedTtlCache } from '../epg/cache';
import { parseExternalProgrammes, parseProviderProgrammes } from '../epg/parsers';
import type { ExternalEpgResponse } from '../epg/parsers';
import type { EpgEntry, EpgSchedule, EpgSource, LoadEpgSchedule } from '../epg/types';
import type { Channel } from '../types/player';
import { fmtTime } from '../utils';

interface UseEpgOptions {
  apiUrl: (params: Record<string, string>) => string;
  jget: (url: string) => Promise<unknown>;
  backendBaseUrl: string;
  epgUrl: string;
}

interface ExternalResult {
  programmes: EpgSchedule['programmes'];
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

const providerIds = new WeakMap<UseEpgOptions['apiUrl'], number>();
let nextProviderId = 1;

function providerId(apiUrl: UseEpgOptions['apiUrl']) {
  const existing = providerIds.get(apiUrl);
  if (existing) return existing;
  const id = nextProviderId;
  nextProviderId += 1;
  providerIds.set(apiUrl, id);
  return id;
}

export function useEpg({ apiUrl, jget, backendBaseUrl, epgUrl }: UseEpgOptions) {
  const [epg, setEpg] = React.useState<EpgEntry | null>(null);
  const epgIntervalRef = React.useRef<ReturnType<typeof setInterval> | null>(null);
  const epgRequestRef = React.useRef(0);
  const externalCacheRef = React.useRef(new BoundedTtlCache<ExternalResult>(EPG_MAX_CACHED_CHANNELS, EPG_TTL_MS));
  const externalInFlightRef = React.useRef(new Map<string, Promise<ExternalResult>>());
  const scheduleCacheRef = React.useRef(new BoundedTtlCache<EpgSchedule>(EPG_MAX_CACHED_CHANNELS, EPG_TTL_MS));
  const scheduleInFlightRef = React.useRef(new Map<string, Promise<EpgSchedule>>());
  const activeProviderId = React.useMemo(() => providerId(apiUrl), [apiUrl]);

  const loadExternalEntries = React.useCallback(async (
    epgChannelId?: string | null,
    channelName?: string,
    force = false,
  ): Promise<ExternalResult> => {
    const channel = String(epgChannelId ?? '').trim();
    const name = String(channelName ?? '').trim();
    const guideUrl = epgUrl.trim();
    if (!guideUrl || (!channel && !name)) return { programmes: [], stale: false };

    const key = externalCacheKey(guideUrl, channel, name);
    const stale = externalCacheRef.current.get(key, true);
    const cached = force ? undefined : externalCacheRef.current.get(key);
    if (cached) return cached;

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
          stale: data.stale === true,
        };
        externalCacheRef.current.set(key, result);
        return result;
      } catch (error) {
        // A stale good answer is much more useful than a blank guide during a
        // temporary feed outage. Mark it stale so the full guide can say so.
        if (stale) return { ...stale, stale: true };
        return {
          programmes: [],
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
  const loadSchedule = React.useCallback<LoadEpgSchedule>(async (channel: Channel, force = false) => {
    const key = scheduleCacheKey(
      epgUrl,
      activeProviderId,
      channel.stream_id,
      channel.epg_channel_id,
      channel.name,
    );
    const cached = force ? undefined : scheduleCacheRef.current.get(key);
    if (cached) return cached;

    const inFlight = scheduleInFlightRef.current.get(key);
    if (inFlight) return inFlight;

    const request = (async (): Promise<EpgSchedule> => {
      const external = await loadExternalEntries(channel.epg_channel_id, channel.name, force);
      let schedule: EpgSchedule;
      const currentTime = Date.now() / 1000;
      const externalCoversNow = external.programmes.some((programme) => (
        programme.start <= currentTime && programme.end > currentTime
      ));

      if (externalCoversNow) {
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
            stream_id: String(channel.stream_id),
            limit: '64',
          }));
          const programmes = parseProviderProgrammes(data);
          const providerCoversNow = programmes.some((programme) => (
            programme.start <= currentTime && programme.end > currentTime
          ));

          if (providerCoversNow || !external.programmes.length) {
            schedule = {
              programmes,
              source: programmes.length ? 'default' : 'none',
              stale: false,
              updatedAt: Date.now(),
              error: programmes.length ? undefined : external.error,
            };
          } else {
            // The open guide still has useful history/future listings, even if
            // neither source can describe what is airing at this instant.
            schedule = {
              programmes: external.programmes,
              source: 'external',
              stale: external.stale,
              updatedAt: Date.now(),
              error: external.error,
            };
          }
        } catch (error) {
          schedule = external.programmes.length
            ? {
                programmes: external.programmes,
                source: 'external',
                stale: external.stale,
                updatedAt: Date.now(),
                error: external.error,
              }
            : {
                programmes: [],
                source: 'none',
                stale: false,
                updatedAt: Date.now(),
                error: external.error || (error as Error)?.message || 'Guide unavailable',
              };
        }
      }

      scheduleCacheRef.current.set(key, schedule);
      return schedule;
    })().finally(() => scheduleInFlightRef.current.delete(key));

    scheduleInFlightRef.current.set(key, request);
    return request;
  }, [activeProviderId, apiUrl, epgUrl, jget, loadExternalEntries]);

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
      const channel: Channel = {
        stream_id: streamId,
        epg_channel_id: epgChannelId,
        name: channelName || 'Channel',
      };
      const schedule = await loadSchedule(channel);
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

        // Refresh a long-running player's schedule in place. Do this before
        // looking for the current programme so a schedule gap can recover too.
        if (!refreshPending && Date.now() - activeSchedule.updatedAt >= EPG_TTL_MS) {
          refreshPending = true;
          void loadSchedule(channel, true)
            .then((fresh) => {
              if (requestId !== epgRequestRef.current) return;
              activeSchedule = fresh;
              entries = fresh.programmes;
              paint();
            })
            .finally(() => { refreshPending = false; });
        }

        const nowSec = Date.now() / 1000;
        const currentIndex = entries.findIndex((entry) => entry.start <= nowSec && entry.end > nowSec);
        if (currentIndex < 0) {
          setEpg(null);
          return;
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
