export type ContentType = 'live' | 'movie' | 'series';

export type Category = {
  category_id: string | number;
  category_name: string;
};

export type Channel = {
  stream_id: string | number;
  name: string;
  stream_icon?: string;
  container_extension?: string;
  series_id?: string | number;
  episode_id?: string | number;
  direct_source?: string;
  isSeries?: boolean;
  isEpisode?: boolean;
};

export type LastChannel = {
  streamId: string;
  name: string;
  catId: string | number | null;
};
