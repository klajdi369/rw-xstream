export type GuideRemoteAction =
  | 'close'
  | 'channel-up'
  | 'channel-down'
  | 'page-up'
  | 'page-down'
  | 'programme-left'
  | 'programme-right'
  | 'watch'
  | 'now'
  | 'refresh';

type RemoteKey = Pick<KeyboardEvent, 'key' | 'keyCode' | 'which'>;

const KEY_CODE_ACTIONS: Record<number, GuideRemoteAction> = {
  8: 'close',
  13: 'watch',
  27: 'close',
  33: 'page-up',
  34: 'page-down',
  37: 'programme-left',
  38: 'channel-up',
  39: 'programme-right',
  40: 'channel-down',
  404: 'close', // HbbTV green
  405: 'now', // HbbTV yellow
  406: 'refresh', // HbbTV blue
  427: 'page-up', // common Channel+
  428: 'page-down', // common Channel-
  458: 'close', // Samsung/LG Guide
  461: 'close', // webOS Back
  10009: 'close', // Samsung Return
};

const KEY_ACTIONS: Record<string, GuideRemoteAction> = {
  Escape: 'close',
  Backspace: 'close',
  BrowserBack: 'close',
  GoBack: 'close',
  Guide: 'close',
  Epg: 'close',
  EPG: 'close',
  ColorF1Green: 'close',
  Green: 'close',
  g: 'close',
  G: 'close',
  ArrowUp: 'channel-up',
  ArrowDown: 'channel-down',
  ArrowLeft: 'programme-left',
  ArrowRight: 'programme-right',
  PageUp: 'page-up',
  ChannelUp: 'page-up',
  MediaTrackPrevious: 'page-up',
  PageDown: 'page-down',
  ChannelDown: 'page-down',
  MediaTrackNext: 'page-down',
  Enter: 'watch',
  Accept: 'watch',
  Select: 'watch',
  ' ': 'watch',
  Home: 'now',
  ColorF2Yellow: 'now',
  Yellow: 'now',
  r: 'refresh',
  R: 'refresh',
  BrowserRefresh: 'refresh',
  ColorF3Blue: 'refresh',
  Blue: 'refresh',
};

export function guideRemoteAction(event: RemoteKey) {
  return KEY_ACTIONS[event.key] || KEY_CODE_ACTIONS[event.keyCode || event.which] || null;
}

export function isGuideToggle(event: RemoteKey) {
  return ['Guide', 'Epg', 'EPG', 'ColorF1Green', 'Green', 'g', 'G'].includes(event.key)
    || [404, 458].includes(event.keyCode || event.which);
}
