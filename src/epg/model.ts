import type { Channel } from '../types/player';
import type { EpgProgramme, EpgSchedule } from './types';

export const HALF_HOUR_SECONDS = 30 * 60;
export const HOUR_SECONDS = 60 * 60;
export const GUIDE_WINDOW_SECONDS = 4 * HOUR_SECONDS;
export const GUIDE_PAGE_SIZE = 7;

export function channelKey(channel: Channel) {
  return String(channel.stream_id);
}

export function currentEpochSeconds() {
  return Math.floor(Date.now() / 1000);
}

export function liveWindowStart(now = currentEpochSeconds()) {
  return Math.floor(now / HALF_HOUR_SECONDS) * HALF_HOUR_SECONDS - HALF_HOUR_SECONDS;
}

export function shiftLocalDay(timestamp: number, amount: number) {
  const date = new Date(timestamp * 1000);
  date.setDate(date.getDate() + amount);
  return Math.floor(date.getTime() / 1000);
}

export function shortGuideDate(timestamp: number) {
  return new Date(timestamp * 1000).toLocaleDateString([], {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}

export function longGuideDate(timestamp: number) {
  return new Date(timestamp * 1000).toLocaleDateString([], {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });
}

export function programmeDuration(programme: EpgProgramme) {
  const minutes = Math.max(1, Math.round((programme.end - programme.start) / 60));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours}h ${remainder}m` : `${hours}h`;
}

export function programmesInWindow(schedule: EpgSchedule | undefined, start: number, end: number) {
  return schedule?.programmes.filter((programme) => programme.end > start && programme.start < end) || [];
}

export function programmePosition(programme: EpgProgramme, start: number, end: number) {
  const duration = end - start;
  const clippedStart = Math.max(programme.start, start);
  const clippedEnd = Math.min(programme.end, end);
  return {
    left: ((clippedStart - start) / duration) * 100,
    width: ((clippedEnd - clippedStart) / duration) * 100,
  };
}

export function windowContaining(programme: EpgProgramme, currentStart: number) {
  if (programme.start < currentStart) {
    return Math.floor(programme.start / HALF_HOUR_SECONDS) * HALF_HOUR_SECONDS;
  }
  if (programme.end > currentStart + GUIDE_WINDOW_SECONDS) {
    return Math.floor(
      (programme.end - GUIDE_WINDOW_SECONDS + HALF_HOUR_SECONDS) / HALF_HOUR_SECONDS,
    ) * HALF_HOUR_SECONDS;
  }
  return currentStart;
}
