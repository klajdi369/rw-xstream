import { send } from '../utils.js';
import { getEpgIndex } from '../epg/store.js';
import { lookupChannel } from '../epg/xmltv.js';

// The client paints "now" and "next" and refetches as a programme ends, so it
// only ever needs a window around the present — not the feed's full week.
const WINDOW_BEHIND_SEC = 3 * 60 * 60;
const WINDOW_AHEAD_SEC = 12 * 60 * 60;
const MAX_PROGRAMMES = 64;

function sendJson(res, status, payload) {
  if (res.headersSent) return send(res, status, 'application/json; charset=utf-8', JSON.stringify(payload));
  // The answer is relative to "now", so it must never sit in a browser cache.
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(payload));
}

/**
 * GET /epg?url=<xmltv>&channel=<epg_channel_id>&name=<channel name>
 *
 * Resolves one channel against a cached, server-parsed guide and returns the
 * programmes around now. Always 200 on a reachable guide — an unmatched
 * channel is a normal answer ({ matched: false }), not an error.
 */
export async function handleEpg(res, url) {
  const target = url.searchParams.get('url');
  if (!target) return sendJson(res, 400, { error: 'Missing url' });

  let guideUrl;
  try {
    guideUrl = new URL(target);
  } catch {
    return sendJson(res, 400, { error: 'Invalid url' });
  }

  if (!['http:', 'https:'].includes(guideUrl.protocol)) {
    return sendJson(res, 400, { error: 'Unsupported protocol' });
  }

  const channelId = url.searchParams.get('channel') || '';
  const channelName = url.searchParams.get('name') || '';
  if (!channelId && !channelName) {
    return sendJson(res, 400, { error: 'Missing channel or name' });
  }

  let index;
  let stale;
  try {
    ({ index, stale } = await getEpgIndex(guideUrl.toString()));
  } catch (err) {
    console.warn(`[EPG] ${guideUrl} unavailable: ${err?.message || err}`);
    return sendJson(res, 502, { error: `Guide unavailable: ${err?.message || String(err)}` });
  }

  const hit = lookupChannel(index, [channelId, channelName]);

  if (!hit) {
    return sendJson(res, 200, { matched: false, stale, programmes: [] });
  }

  const now = Date.now() / 1000;
  const from = now - WINDOW_BEHIND_SEC;
  const until = now + WINDOW_AHEAD_SEC;
  const programmes = hit.programmes
    .filter((programme) => programme.stop > from && programme.start < until)
    .slice(0, MAX_PROGRAMMES);

  sendJson(res, 200, {
    matched: true,
    stale,
    matchType: hit.matchType,
    matchedOn: hit.matchedOn,
    programmes,
  });
}
