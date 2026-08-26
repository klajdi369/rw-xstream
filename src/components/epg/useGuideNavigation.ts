import React from 'react';
import {
  GUIDE_WINDOW_SECONDS,
  HALF_HOUR_SECONDS,
  HOUR_SECONDS,
  channelKey,
  currentEpochSeconds,
  liveWindowStart,
  programmesInWindow,
  windowContaining,
} from '../../epg/model';
import type { EpgProgramme, EpgSchedule } from '../../epg/types';
import type { Channel } from '../../types/player';
import { clamp } from '../../utils';

type Options = {
  open: boolean;
  channels: Channel[];
  schedules: Map<string, EpgSchedule>;
  initialIndex: number;
};

export function useGuideNavigation({ open, channels, schedules, initialIndex }: Options) {
  const [selectedChannelIndex, setSelectedChannelIndex] = React.useState(0);
  const [selectedProgrammeStart, setSelectedProgrammeStart] = React.useState<number | null>(null);
  const [windowStart, setWindowStart] = React.useState(liveWindowStart);
  const [now, setNow] = React.useState(currentEpochSeconds);

  React.useEffect(() => {
    if (!open) return;
    const current = currentEpochSeconds();
    setSelectedChannelIndex(initialIndex);
    setSelectedProgrammeStart(null);
    setWindowStart(liveWindowStart(current));
    setNow(current);
  }, [initialIndex, open]);

  React.useEffect(() => {
    if (!open) return;
    const timer = window.setInterval(() => setNow(currentEpochSeconds()), 30_000);
    return () => window.clearInterval(timer);
  }, [open]);

  const selectedChannel = channels[selectedChannelIndex];
  const selectedSchedule = selectedChannel ? schedules.get(channelKey(selectedChannel)) : undefined;
  const selectedProgramme = React.useMemo(() => {
    if (!selectedSchedule?.programmes.length) return undefined;
    const visible = programmesInWindow(
      selectedSchedule,
      windowStart,
      windowStart + GUIDE_WINDOW_SECONDS,
    );
    const exact = visible.find((programme) => programme.start === selectedProgrammeStart);
    if (exact) return exact;
    return visible.find((programme) => programme.start <= now && programme.end > now) || visible[0];
  }, [now, selectedProgrammeStart, selectedSchedule, windowStart]);

  const revealProgramme = React.useCallback((programme: EpgProgramme) => {
    setSelectedProgrammeStart(programme.start);
    setWindowStart((previous) => windowContaining(programme, previous));
  }, []);

  const selectChannel = React.useCallback((index: number, targetTime?: number) => {
    const nextIndex = clamp(index, 0, Math.max(0, channels.length - 1));
    const nextChannel = channels[nextIndex];
    const target = targetTime ?? selectedProgramme?.start ?? now;
    const visible = nextChannel
      ? programmesInWindow(
          schedules.get(channelKey(nextChannel)),
          windowStart,
          windowStart + GUIDE_WINDOW_SECONDS,
        )
      : [];
    const programme = visible.find((entry) => entry.start <= target && entry.end > target) || visible[0];

    setSelectedChannelIndex(nextIndex);
    setSelectedProgrammeStart(programme?.start ?? null);
  }, [channels, now, schedules, selectedProgramme, windowStart]);

  const moveChannel = React.useCallback((amount: number) => {
    selectChannel(selectedChannelIndex + amount);
  }, [selectChannel, selectedChannelIndex]);

  const moveProgramme = React.useCallback((direction: -1 | 1) => {
    const programmes = selectedSchedule?.programmes || [];
    if (!programmes.length) {
      setWindowStart((previous) => previous + direction * HOUR_SECONDS);
      return;
    }

    if (!selectedProgramme) {
      const visible = programmesInWindow(
        selectedSchedule,
        windowStart,
        windowStart + GUIDE_WINDOW_SECONDS,
      );
      const nextVisible = direction > 0 ? visible[0] : visible[visible.length - 1];
      if (nextVisible) revealProgramme(nextVisible);
      else setWindowStart((previous) => previous + direction * HOUR_SECONDS);
      return;
    }

    const selectedIndex = programmes.findIndex((programme) => programme.start === selectedProgramme.start);
    const nextProgramme = programmes[selectedIndex + direction];

    if (nextProgramme) revealProgramme(nextProgramme);
    else setWindowStart((previous) => previous + direction * HOUR_SECONDS);
  }, [revealProgramme, selectedProgramme, selectedSchedule, windowStart]);

  const jumpToTime = React.useCallback((target: number, keepNowOffset = false) => {
    const aligned = Math.floor(target / HALF_HOUR_SECONDS) * HALF_HOUR_SECONDS;
    const nextWindowStart = aligned - (keepNowOffset ? HALF_HOUR_SECONDS : 0);
    const visible = programmesInWindow(
      selectedSchedule,
      nextWindowStart,
      nextWindowStart + GUIDE_WINDOW_SECONDS,
    );
    const programme = visible.find((entry) => entry.start <= target && entry.end > target) || visible[0];

    setWindowStart(nextWindowStart);
    setSelectedProgrammeStart(programme?.start ?? null);
  }, [selectedSchedule]);

  const jumpToNow = React.useCallback(() => jumpToTime(now, true), [jumpToTime, now]);

  return {
    now,
    windowStart,
    windowEnd: windowStart + GUIDE_WINDOW_SECONDS,
    selectedChannelIndex,
    selectedChannel,
    selectedSchedule,
    selectedProgramme,
    selectChannel,
    moveChannel,
    moveProgramme,
    revealProgramme,
    jumpToTime,
    jumpToNow,
  };
}
