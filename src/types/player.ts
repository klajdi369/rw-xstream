export type Category = {
  category_id: string | number;
  category_name: string;
};

export type Channel = {
  stream_id: string | number;
  name: string;
};

export type LastChannel = {
  streamId: string;
  name: string;
  catId: string | number | null;
};
