import React from 'react';
import { Category, VodStream } from '../types/player';

interface UseVodOptions {
  apiUrl: (params: Record<string, string>) => string;
  jget: (url: string) => Promise<unknown>;
}

/**
 * VOD (movies) data layer. Deliberately standalone from the live-TV hooks: it
 * only borrows the generic `apiUrl` / `jget` helpers (which already carry the
 * proxy fallback) and owns its own categories/streams state and cache, so
 * nothing here can perturb live playback or channel navigation.
 */
export function useVod({ apiUrl, jget }: UseVodOptions) {
  const [categories, setCategories] = React.useState<Category[]>([]);
  const [streams, setStreams] = React.useState<VodStream[]>([]);
  const [activeCatId, setActiveCatId] = React.useState<string>('');
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState('');

  // The full catalog (every category) — loaded lazily the first time the user
  // searches, so search can span all categories rather than the open one.
  const [allStreams, setAllStreams] = React.useState<VodStream[]>([]);
  const [allLoading, setAllLoading] = React.useState(false);

  const streamCacheRef = React.useRef<Map<string, VodStream[]>>(new Map());
  const loadedCategoriesRef = React.useRef(false);
  const allLoadRef = React.useRef<Promise<VodStream[]> | null>(null);

  const loadCategories = React.useCallback(async (force = false): Promise<Category[]> => {
    if (loadedCategoriesRef.current && !force) return categories;
    setError('');
    try {
      const raw = await jget(apiUrl({ action: 'get_vod_categories' }));
      const all = (Array.isArray(raw) ? raw : []) as Category[];
      all.sort((a, b) => String(a.category_name || '').localeCompare(String(b.category_name || '')));
      loadedCategoriesRef.current = true;
      setCategories(all);
      return all;
    } catch (e) {
      setError(`Failed to load movie categories — ${(e as Error)?.message || 'connection error'}`);
      return [];
    }
  }, [apiUrl, categories, jget]);

  const loadStreams = React.useCallback(async (cat: Category): Promise<void> => {
    const id = String(cat.category_id);
    setActiveCatId(id);
    setError('');

    const cached = streamCacheRef.current.get(id);
    if (cached) {
      setStreams(cached);
      return;
    }

    setLoading(true);
    try {
      const data = await jget(apiUrl({ action: 'get_vod_streams', category_id: id }));
      const list = (Array.isArray(data) ? data : []) as VodStream[];
      list.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
      streamCacheRef.current.set(id, list);
      setStreams(list);
    } catch (e) {
      setStreams([]);
      setError(`Failed to load movies — ${(e as Error)?.message || 'connection error'}`);
    } finally {
      setLoading(false);
    }
  }, [apiUrl, jget]);

  // Load (once) every VOD stream across all categories. Xtream returns the whole
  // catalog when `get_vod_streams` is called with no category_id.
  const loadAllStreams = React.useCallback((): Promise<VodStream[]> => {
    if (allStreams.length) return Promise.resolve(allStreams);
    if (allLoadRef.current) return allLoadRef.current;

    setAllLoading(true);
    allLoadRef.current = (async () => {
      try {
        const data = await jget(apiUrl({ action: 'get_vod_streams' }));
        const list = (Array.isArray(data) ? data : []) as VodStream[];
        list.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
        setAllStreams(list);
        return list;
      } catch (e) {
        setError(`Failed to load movie catalog — ${(e as Error)?.message || 'connection error'}`);
        return [];
      } finally {
        setAllLoading(false);
        allLoadRef.current = null;
      }
    })();
    return allLoadRef.current;
  }, [allStreams, apiUrl, jget]);

  return {
    categories,
    streams,
    activeCatId,
    loading,
    error,
    allStreams,
    allLoading,
    loadCategories,
    loadStreams,
    loadAllStreams,
  };
}
