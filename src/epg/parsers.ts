import { decodePossiblyBase64Utf8, parseEpgTs } from '../utils';
import type { EpgProgramme } from './types';

export interface ExternalEpgResponse {
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

function sortValidProgrammes(programmes: EpgProgramme[]) {
  return programmes
    .filter((entry) => entry.title && entry.start > 0 && entry.end > entry.start)
    .sort((a, b) => a.start - b.start);
}

export function parseExternalProgrammes(data: ExternalEpgResponse) {
  return sortValidProgrammes((data.programmes || []).map((entry) => ({
    title: String(entry.title ?? '').trim(),
    start: parseEpgTs(entry.start),
    end: parseEpgTs(entry.stop),
    description: String(entry.description ?? '').trim() || undefined,
    category: String(entry.category ?? '').trim() || undefined,
  })));
}

export function parseProviderProgrammes(data: unknown) {
  const record = (data && typeof data === 'object') ? data as Record<string, unknown> : {};
  const rawListings = record.epg_listings || record.Epg_listings || record.listings || [];
  const listings = Array.isArray(rawListings) ? rawListings : [];

  return sortValidProgrammes(listings.map((raw) => {
    const entry = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {};
    return {
      title: decodePossiblyBase64Utf8(entry.title ?? entry.name ?? entry.programme_title ?? '').trim(),
      start: parseEpgTs(entry.start_timestamp ?? entry.start ?? entry.start_ts ?? entry.begin ?? entry.from),
      end: parseEpgTs(entry.stop_timestamp ?? entry.end_timestamp ?? entry.end ?? entry.stop ?? entry.to),
      description: decodePossiblyBase64Utf8(entry.description ?? entry.desc ?? '').trim() || undefined,
      category: decodePossiblyBase64Utf8(entry.category ?? '').trim() || undefined,
    };
  }));
}
