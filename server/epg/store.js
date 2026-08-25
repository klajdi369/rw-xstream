// Fetches XMLTV guides and keeps the parsed index in memory.
//
// Parsing happens here, once per feed, instead of in every browser tab: a
// guide is several megabytes of XML that every client would otherwise download
// and walk on its own every few minutes.

import { buildEpgIndex } from './xmltv.js';

const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
const TTL_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 30_000;
// Guides run to a few MB; anything past this is not a guide and we refuse to
// hold it in memory.
const MAX_BYTES = 96 * 1024 * 1024;
// Bounds memory when several feeds are configured over a long uptime.
const MAX_CACHED_FEEDS = 4;
// How long a failed refresh suppresses further attempts for that feed.
const RETRY_COOLDOWN_MS = 60 * 1000;

/** @type {Map<string, { fetchedAt: number, index: import('./xmltv.js').EpgIndex }>} */
const cache = new Map();
/** @type {Map<string, Promise<import('./xmltv.js').EpgIndex>>} */
const inFlight = new Map();
/** @type {Map<string, number>} */
const failedAt = new Map();

/** Decode a guide body, honouring the encoding its XML declaration announces. */
function decodeXml(buffer) {
  const bytes = new Uint8Array(buffer);
  const declaration = new TextDecoder('latin1').decode(bytes.subarray(0, 256));
  const charset = declaration.match(/encoding\s*=\s*["']([\w-]+)["']/i)?.[1];

  if (charset && !/^utf-?8$/i.test(charset)) {
    try {
      return new TextDecoder(charset, { fatal: false }).decode(bytes);
    } catch {
      // Unknown label — fall through to UTF-8, which is right far more often
      // than it is wrong.
    }
  }

  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

async function fetchIndex(url) {
  const response = await fetch(url, {
    headers: { 'user-agent': USER_AGENT, accept: 'application/xml, text/xml, */*' },
    redirect: 'follow',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!response.ok) throw new Error(`guide HTTP ${response.status}`);

  const declaredLength = Number(response.headers.get('content-length') || 0);
  if (declaredLength > MAX_BYTES) throw new Error(`guide too large (${declaredLength} bytes)`);

  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > MAX_BYTES) throw new Error(`guide too large (${buffer.byteLength} bytes)`);

  const index = buildEpgIndex(decodeXml(buffer));
  if (index.programmeCount === 0) throw new Error('guide contained no usable programmes');

  return index;
}

function evictOldest() {
  while (cache.size > MAX_CACHED_FEEDS) {
    let oldestUrl = null;
    let oldestAt = Infinity;
    for (const [url, entry] of cache) {
      if (entry.fetchedAt < oldestAt) {
        oldestAt = entry.fetchedAt;
        oldestUrl = url;
      }
    }
    if (oldestUrl === null) return;
    cache.delete(oldestUrl);
  }
}

/**
 * Get the parsed index for a guide, refreshing it at most once per TTL.
 * Concurrent callers share a single fetch, and a failed refresh keeps serving
 * the cached copy rather than blanking the guide.
 *
 * @param {string} url
 * @returns {Promise<{ index: import('./xmltv.js').EpgIndex, fetchedAt: number, stale: boolean }>}
 */
export async function getEpgIndex(url) {
  const cached = cache.get(url);
  if (cached && Date.now() - cached.fetchedAt < TTL_MS) {
    return { index: cached.index, fetchedAt: cached.fetchedAt, stale: false };
  }

  // A guide that just failed shouldn't be re-fetched on every zap; keep
  // serving what we have until the cool-off expires.
  const lastFailure = failedAt.get(url) ?? 0;
  if (cached && Date.now() - lastFailure < RETRY_COOLDOWN_MS) {
    return { index: cached.index, fetchedAt: cached.fetchedAt, stale: true };
  }

  let pending = inFlight.get(url);
  if (!pending) {
    pending = fetchIndex(url).finally(() => inFlight.delete(url));
    inFlight.set(url, pending);
  }

  try {
    const index = await pending;
    const fetchedAt = Date.now();
    cache.set(url, { fetchedAt, index });
    failedAt.delete(url);
    evictOldest();
    console.log(`[EPG] indexed ${url} channels=${index.channelCount} programmes=${index.programmeCount}`);
    return { index, fetchedAt, stale: false };
  } catch (err) {
    failedAt.set(url, Date.now());
    if (cached) {
      console.warn(`[EPG] refresh failed for ${url}, serving cached copy: ${err?.message || err}`);
      return { index: cached.index, fetchedAt: cached.fetchedAt, stale: true };
    }
    throw err;
  }
}
