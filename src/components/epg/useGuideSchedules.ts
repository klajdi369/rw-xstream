import React from 'react';
import { channelKey } from '../../epg/model';
import type { EpgSchedule, GuideLoadState, LoadEpgSchedule } from '../../epg/types';
import type { Channel } from '../../types/player';

const LOAD_WORKERS = 3;
const REFRESH_INTERVAL_MS = 10 * 60 * 1000;
const SCHEDULE_COMMIT_INTERVAL_MS = 60;

type Options = {
  open: boolean;
  channels: Channel[];
  priorityIndex: number;
  loadSchedule: LoadEpgSchedule;
};

function channelsByDistance(channels: Channel[], priorityIndex: number) {
  return channels
    .map((channel, index) => ({ channel, index, distance: Math.abs(index - priorityIndex) }))
    .sort((left, right) => left.distance - right.distance || left.index - right.index)
    .map(({ channel }) => channel);
}

export function useGuideSchedules({ open, channels, priorityIndex, loadSchedule }: Options) {
  const [schedules, setSchedules] = React.useState<Map<string, EpgSchedule>>(new Map());
  const [loadState, setLoadState] = React.useState<GuideLoadState>({ loaded: 0, total: 0, loading: false });
  const [refreshRequest, setRefreshRequest] = React.useState(0);
  const forceRequestRef = React.useRef<number | null>(null);

  const refresh = React.useCallback(() => {
    setRefreshRequest((previous) => {
      const next = previous + 1;
      forceRequestRef.current = next;
      return next;
    });
  }, []);

  React.useEffect(() => {
    if (!open) return;

    let cancelled = false;
    const force = forceRequestRef.current === refreshRequest;
    const orderedChannels = channelsByDistance(channels, priorityIndex);
    const validKeys = new Set(channels.map(channelKey));
    let cursor = 0;
    let loaded = 0;
    let pendingSchedules = new Map<string, EpgSchedule>();
    let commitTimer: number | null = null;

    setSchedules((previous) => {
      if (force) return new Map();
      return new Map(Array.from(previous).filter(([key]) => validKeys.has(key)));
    });
    setLoadState({ loaded: 0, total: channels.length, loading: channels.length > 0 });

    // A large category can finish hundreds of local/cache-backed requests in a
    // burst. Commit them together so React does not clone a growing Map and
    // repaint the guide once per channel while the user is navigating.
    const commitPending = () => {
      commitTimer = null;
      if (cancelled || pendingSchedules.size === 0) return;
      const batch = pendingSchedules;
      pendingSchedules = new Map();
      setSchedules((previous) => {
        const next = new Map(previous);
        batch.forEach((schedule, key) => next.set(key, schedule));
        return next;
      });
      setLoadState({ loaded, total: channels.length, loading: loaded < channels.length });
    };

    const queueSchedule = (key: string, schedule: EpgSchedule) => {
      pendingSchedules.set(key, schedule);
      if (commitTimer === null) {
        commitTimer = window.setTimeout(commitPending, SCHEDULE_COMMIT_INTERVAL_MS);
      }
    };

    const worker = async () => {
      while (!cancelled) {
        const channel = orderedChannels[cursor];
        cursor += 1;
        if (!channel) return;

        let schedule: EpgSchedule;
        try {
          schedule = await loadSchedule(channel, force);
        } catch (error) {
          schedule = {
            programmes: [],
            source: 'none',
            stale: false,
            updatedAt: Date.now(),
            error: (error as Error)?.message || 'Guide unavailable',
          };
        }
        if (cancelled) return;

        loaded += 1;
        queueSchedule(channelKey(channel), schedule);
      }
    };

    void Promise.all(Array.from(
      { length: Math.min(LOAD_WORKERS, orderedChannels.length) },
      () => worker(),
    )).then(() => {
      if (cancelled) return;
      if (commitTimer !== null) window.clearTimeout(commitTimer);
      commitPending();
      setLoadState({ loaded, total: channels.length, loading: false });
      if (forceRequestRef.current === refreshRequest) forceRequestRef.current = null;
    });

    return () => {
      cancelled = true;
      if (commitTimer !== null) window.clearTimeout(commitTimer);
    };
  }, [channels, loadSchedule, open, priorityIndex, refreshRequest]);

  React.useEffect(() => {
    if (!open) return;
    const timer = window.setInterval(refresh, REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [open, refresh]);

  return { schedules, loadState, refresh };
}
