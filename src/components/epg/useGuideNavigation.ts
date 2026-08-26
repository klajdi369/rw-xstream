import React from 'react';
import {
  GUIDE_WINDOW_SECONDS,
  HALF_HOUR_SECONDS,
  HOUR_SECONDS,
  channelKey,
  currentEpochSeconds,
  liveWindowStart,
  programmeAt,
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
    return selectedSchedule.programmes.find((programme) => programme.start === selectedProgrammeStart)
      || programmeAt(selectedSchedule, now);
  }, [now, selectedProgrammeStart, selectedSchedule]);

  const revealProgramme = React.useCallback((programme: EpgProgramme) => {
    setSelectedProgrammeStart(programme.start);
    setWindowStart((previous) => windowContaining(programme, previous));
  }, []);

  const selectChannel = React.useCallback((index: number, targetTime?: number) => {
    const nextIndex = clamp(index, 0, Math.max(0, channels.length - 1));
    const nextChannel = channels[nextIndex];
    const target = targetTime ?? selectedProgramme?.start ?? now;
    const programme = nextChannel ? programmeAt(schedules.get(channelKey(nextChannel)), target) : undefined;

    setSelectedChannelIndex(nextIndex);
    setSelectedProgrammeStart(programme?.start ?? null);
  }, [channels, now, schedules, selectedProgramme]);

  const moveChannel = React.useCallback((amount: number) => {
    selectChannel(selectedChannelIndex + amount);
  }, [selectChannel, selectedChannelIndex]);

  const moveProgramme = React.useCallback((direction: -1 | 1) => {
    const programmes = selectedSchedule?.programmes || [];
    if (!programmes.length) {
      setWindowStart((previous) => previous + direction * HOUR_SECONDS);
      return;
    }

    const selectedIndex = selectedProgramme
      ? programmes.findIndex((programme) => programme.start === selectedProgramme.start)
      : -1;
    const fallbackIndex = direction > 0 ? 0 : programmes.length - 1;
    const nextProgramme = programmes[selectedIndex >= 0 ? selectedIndex + direction : fallbackIndex];

    if (nextProgramme) revealProgramme(nextProgramme);
    else setWindowStart((previous) => previous + direction * HOUR_SECONDS);
  }, [revealProgramme, selectedProgramme, selectedSchedule]);

  const jumpToTime = React.useCallback((target: number, keepNowOffset = false) => {
    const aligned = Math.floor(target / HALF_HOUR_SECONDS) * HALF_HOUR_SECONDS;
    setWindowStart(aligned - (keepNowOffset ? HALF_HOUR_SECONDS : 0));
    setSelectedProgrammeStart(programmeAt(selectedSchedule, target)?.start ?? null);
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
