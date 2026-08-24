export const SAVE_KEY = 'xtream_tv_v4';
export const LAST_KEY = 'xtream_last_ch';
export const CHANNEL_PROXY_MEMORY_KEY = 'xtream_channel_proxy_memory_v1';
export const CHANNEL_ORDER_KEY = 'xtream_channel_custom_order_v1';
export const CHANNEL_ORDER_MODE_KEY = 'xtream_channel_order_mode_v1';
export const CHANNEL_PROXY_MAX_VISITS = 6;
export const CHANNEL_ROW_JUMP = 8;
export const HIDE_CATEGORIES = true;
export const CATEGORY_UNLOCK_PRESS_COUNT = 4;
export const CATEGORY_UNLOCK_WINDOW_MS = 1400;

// ── VOD (movies) ───────────────────────────────────────────────────────────────
export const VOD_PROGRESS_KEY = 'xtream_vod_progress_v1';
// How far to jump on a seek key, and how often to persist resume progress.
export const VOD_SEEK_STEP_SECONDS = 10;
export const VOD_PROGRESS_SAVE_INTERVAL_MS = 5000;
// Don't offer to resume trivially-short watches, and treat near-the-end as done.
export const VOD_RESUME_MIN_SECONDS = 15;
export const VOD_RESUME_END_PAD_SECONDS = 20;
