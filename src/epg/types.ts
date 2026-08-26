import type { Channel } from '../types/player';

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

export type LoadEpgSchedule = (channel: Channel, force?: boolean) => Promise<EpgSchedule>;

export interface GuideLoadState {
  loaded: number;
  total: number;
  loading: boolean;
}
