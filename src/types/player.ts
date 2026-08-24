export type Category = {
  category_id: string | number;
  category_name: string;
};

export type Channel = {
  stream_id: string | number;
  name: string;
  epg_channel_id?: string | null;
};

export type LastChannel = {
  streamId: string;
  name: string;
  catId: string | number | null;
};

// ── VOD (movies) ───────────────────────────────────────────────────────────────
export type VodStream = {
  stream_id: string | number;
  name: string;
  stream_icon?: string;
  container_extension?: string;
  rating?: string | number;
  added?: string;
};

// Per-movie resume position, keyed by stream_id in localStorage.
export type VodProgress = {
  position: number;
  duration: number;
  updatedAt: number;
};
