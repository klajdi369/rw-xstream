// Channel-name matching keys.
//
// Providers and XMLTV feeds rarely agree on how a channel is spelled: the
// Xtream list may say "AL| Top Channel HD" while the guide says "Top Channel".
// We therefore match on two levels — an exact key (punctuation/case folded)
// and a loose key that also drops quality and region decorations.

/**
 * Fold a channel identifier down to letters and digits. This is the exact key;
 * "TV Klan", "tv-klan" and "TV_Klan" all collapse to "tvklan".
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeKey(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

// Whole words that carry no identity — safe to drop from either end of a name.
// Only ever compared against complete tokens, so "Kanal" never loses its "al"
// and "Digitalb" never loses its "alb".
const NOISE_TOKENS = new Set([
  'fullhd', '1080p', '1080i', '720p', '720i', 'uhd', 'fhd', 'hevc', 'h265', 'h264',
  '4k', '8k', 'hd', 'sd',
  'al', 'alb', 'albania', 'albanian', 'sq', 'shqip',
  'backup', 'bk', 'alt',
  // Guides and provider lists disagree constantly about this one: "TV Klan"
  // against "klan.al", "Report TV" against "reporttv".
  'tv',
]);

// Quality markers glued straight onto a name with no separator, as in
// "tvklanhd". Longest first so "fullhd" wins over "hd".
const GLUED_QUALITY = ['fullhd', '1080p', '1080i', '720p', 'hevc', 'h265', 'h264', 'uhd', 'fhd', '4k', '8k', 'hd', 'sd'];

// Leaves enough of a name behind that stripping a glued suffix can't turn one
// channel into another (e.g. refuses to shorten "ahd" to "a").
const MIN_STEM_LENGTH = 4;

/**
 * Fold a channel identifier down past quality and region decorations, so
 * "AL| Top Channel HD" and "Top Channel" land on the same key. Returns '' when
 * nothing identifying survives, which callers must treat as "no match".
 * @param {unknown} value
 * @returns {string}
 */
export function looseKey(value) {
  const tokens = String(value ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

  // Trim noise from both ends but never from the middle: "Top Channel HD News"
  // keeps its "HD" because dropping an interior word can change the name.
  let start = 0;
  let end = tokens.length;
  while (start < end && NOISE_TOKENS.has(tokens[start])) start += 1;
  while (end > start && NOISE_TOKENS.has(tokens[end - 1])) end -= 1;
  if (start >= end) return '';

  let key = tokens.slice(start, end).join('');

  for (const suffix of GLUED_QUALITY) {
    if (key.endsWith(suffix) && key.length - suffix.length >= MIN_STEM_LENGTH) {
      key = key.slice(0, -suffix.length);
      break;
    }
  }

  // Same idea for a "tv" welded to the front, as in "TVKlan.al" — the token
  // pass above can only see it when a separator sets it apart.
  if (key.startsWith('tv') && key.length - 2 >= MIN_STEM_LENGTH) {
    key = key.slice(2);
  }

  // A one-character key matches far too eagerly to be worth trusting.
  return key.length >= 2 ? key : '';
}
