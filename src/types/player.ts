export type VodMovie = {
  kind: 'movie';
  id: string;
  name: string;
  containerExtension: string;
};

export type SeriesResult = {
  kind: 'series';
  id: string;
  name: string;
};

export type SeriesEpisode = {
  id: string;
  title: string;
  season: number;
  episodeNum: number;
  containerExtension: string;
};

export type MediaResult = VodMovie | SeriesResult;

export type LastPlayed = {
  kind: 'movie' | 'episode';
  id: string;
  name: string;
  seriesId?: string;
};
