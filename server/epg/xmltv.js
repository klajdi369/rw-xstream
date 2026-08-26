// A small XMLTV reader.
//
// XMLTV is machine-generated and extremely regular, so a scanner over the two
// element types we care about — <channel> and <programme> — is enough, and it
// keeps the server dependency-free.

import { normalizeKey, looseKey } from './keys.js';

const CHANNEL_RE = /<channel\b([^>]*?)(?:\/>|>([\s\S]*?)<\/channel\s*>)/gi;
const PROGRAMME_RE = /<programme\b([^>]*?)(?:\/>|>([\s\S]*?)<\/programme\s*>)/gi;
const ATTR_RE = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const DISPLAY_NAME_RE = /<display-name\b[^>]*>([\s\S]*?)<\/display-name\s*>/gi;
const TITLE_RE = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i;
const SUB_TITLE_RE = /<sub-title\b[^>]*>([\s\S]*?)<\/sub-title\s*>/i;
const DESC_RE = /<desc\b[^>]*>([\s\S]*?)<\/desc\s*>/i;
const CATEGORY_RE = /<category\b[^>]*>([\s\S]*?)<\/category\s*>/i;

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
};

function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (match, body) => {
    if (body[0] === '#') {
      const codePoint = body[1] === 'x' || body[1] === 'X'
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      try {
        return String.fromCodePoint(codePoint);
      } catch {
        return match; // out of range or a lone surrogate — leave it alone
      }
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named === undefined ? match : named;
  });
}

// A character XML can never contain, so it can stand in for a CDATA block
// without colliding with the document's own text.
const CDATA_MARK = '\u0000';
const CDATA_SLOT_RE = new RegExp(`${CDATA_MARK}(\\d+)${CDATA_MARK}`, 'g');

/** Flatten an element's inner XML to plain text. */
function textContent(raw) {
  if (!raw) return '';

  // CDATA is literal: pull it out before entity decoding so an "&amp;" inside a
  // CDATA block stays "&amp;", then splice it back afterwards.
  const literals = [];
  let text = raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_match, inner) => {
    literals.push(inner);
    return `${CDATA_MARK}${literals.length - 1}${CDATA_MARK}`;
  });

  text = text.replace(/<[^>]*>/g, '');
  text = decodeEntities(text);
  CDATA_SLOT_RE.lastIndex = 0;
  text = text.replace(CDATA_SLOT_RE, (_match, index) => literals[Number(index)] ?? '');

  return text.replace(/\s+/g, ' ').trim();
}

function parseAttributes(raw) {
  const attrs = {};
  ATTR_RE.lastIndex = 0;
  let match;
  while ((match = ATTR_RE.exec(raw)) !== null) {
    attrs[match[1].toLowerCase()] = decodeEntities(match[2] ?? match[3] ?? '');
  }
  return attrs;
}

/**
 * Parse an XMLTV timestamp ("20240131203000 +0100") to epoch seconds.
 * Shorter forms are padded, per the spec's variable-precision dates.
 * @param {string} value
 * @returns {number} epoch seconds, or 0 when unparseable
 */
export function parseXmltvTs(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return 0;

  const match = raw.match(/^(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?\s*(Z|[+-]\d{4})?$/);
  if (!match) return 0;

  const [, year, month = '01', day = '01', hour = '00', minute = '00', second = '00', zone] = match;
  const utcSeconds = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  ) / 1000;
  if (!Number.isFinite(utcSeconds)) return 0;

  if (!zone || zone === 'Z') return Math.floor(utcSeconds);

  const sign = zone.startsWith('-') ? -1 : 1;
  const offsetSeconds = sign * ((Number(zone.slice(1, 3)) * 60 + Number(zone.slice(3, 5))) * 60);
  return Math.floor(utcSeconds - offsetSeconds);
}

/**
 * @typedef {{ title: string, start: number, stop: number, description?: string, category?: string }} Programme
 * @typedef {{
 *   programmes: Map<string, Programme[]>,
 *   byId: Map<string, string>,
 *   byName: Map<string, string>,
 *   byLoose: Map<string, string>,
 *   channelCount: number,
 *   programmeCount: number,
 * }} EpgIndex
 */

/**
 * Build a lookup index from an XMLTV document.
 *
 * Programmes are keyed by their `channel` attribute; `<channel>` elements add
 * alias entries (its id and every `<display-name>`) pointing at that key, which
 * is what lets a provider's human-readable name find a feed that identifies its
 * channels by opaque id.
 *
 * @param {string} xml
 * @returns {EpgIndex}
 */
export function buildEpgIndex(xml) {
  const body = String(xml ?? '').replace(/<!--[\s\S]*?-->/g, '');

  /** @type {Map<string, Programme[]>} */
  const programmes = new Map();
  /** @type {Map<string, string>} */
  const byId = new Map();
  /** @type {Map<string, string>} */
  const byName = new Map();
  /** @type {Map<string, string>} */
  const byLoose = new Map();
  // A loose key two different channels both claim is worse than no key at all.
  const ambiguousLoose = new Set();

  const addAlias = (map, key, target) => {
    if (!key || !target) return;
    if (!map.has(key)) map.set(key, target);
  };

  const addLoose = (key, target) => {
    if (!key || !target || ambiguousLoose.has(key)) return;
    const existing = byLoose.get(key);
    if (existing === undefined) {
      byLoose.set(key, target);
      return;
    }
    if (existing !== target) {
      byLoose.delete(key);
      ambiguousLoose.add(key);
    }
  };

  let programmeCount = 0;
  PROGRAMME_RE.lastIndex = 0;
  let match;
  while ((match = PROGRAMME_RE.exec(body)) !== null) {
    const attrs = parseAttributes(match[1] ?? '');
    const key = normalizeKey(attrs.channel);
    if (!key) continue;

    const start = parseXmltvTs(attrs.start);
    const stop = parseXmltvTs(attrs.stop);
    if (!(start > 0 && stop > start)) continue;

    const inner = match[2] ?? '';
    const baseTitle = textContent(inner.match(TITLE_RE)?.[1] ?? '');
    const subTitle = textContent(inner.match(SUB_TITLE_RE)?.[1] ?? '');
    const title = baseTitle && subTitle && !baseTitle.toLowerCase().includes(subTitle.toLowerCase())
      ? `${baseTitle}: ${subTitle}`
      : (baseTitle || subTitle);
    if (!title) continue;

    const description = textContent(inner.match(DESC_RE)?.[1] ?? '');
    const category = textContent(inner.match(CATEGORY_RE)?.[1] ?? '');
    const programme = {
      title,
      start,
      stop,
      ...(description ? { description } : {}),
      ...(category ? { category } : {}),
    };

    const list = programmes.get(key);
    if (list) list.push(programme);
    else programmes.set(key, [programme]);
    programmeCount += 1;

    // Feeds are not obliged to declare every channel they carry, so a
    // programme's own channel attribute is an alias in its own right.
    addAlias(byId, key, key);
    addLoose(looseKey(attrs.channel), key);
  }

  let channelCount = 0;
  CHANNEL_RE.lastIndex = 0;
  while ((match = CHANNEL_RE.exec(body)) !== null) {
    const attrs = parseAttributes(match[1] ?? '');
    const target = normalizeKey(attrs.id);
    if (!target) continue;
    channelCount += 1;

    addAlias(byId, target, target);
    addLoose(looseKey(attrs.id), target);

    const inner = match[2] ?? '';
    DISPLAY_NAME_RE.lastIndex = 0;
    let nameMatch;
    while ((nameMatch = DISPLAY_NAME_RE.exec(inner)) !== null) {
      const displayName = textContent(nameMatch[1]);
      if (!displayName) continue;
      addAlias(byName, normalizeKey(displayName), target);
      addLoose(looseKey(displayName), target);
    }
  }

  for (const list of programmes.values()) {
    list.sort((a, b) => a.start - b.start);
  }

  return { programmes, byId, byName, byLoose, channelCount, programmeCount };
}

/**
 * Resolve a channel to its programmes, trying every candidate at each level of
 * precision before falling back to a looser one.
 *
 * @param {EpgIndex} index
 * @param {Array<string|null|undefined>} candidates identifiers, most trusted first
 * @returns {{ programmes: Programme[], matchType: 'id'|'display-name'|'loose', matchedOn: string } | null}
 */
export function lookupChannel(index, candidates) {
  const wanted = candidates.map((candidate) => String(candidate ?? '').trim()).filter(Boolean);

  /** @type {Array<['id'|'display-name'|'loose', Map<string, string>, (value: string) => string]>} */
  const levels = [
    ['id', index.byId, normalizeKey],
    ['display-name', index.byName, normalizeKey],
    ['loose', index.byLoose, looseKey],
  ];

  for (const [matchType, map, toKey] of levels) {
    for (const candidate of wanted) {
      const key = toKey(candidate);
      if (!key) continue;
      const target = map.get(key);
      if (!target) continue;
      const programmes = index.programmes.get(target);
      if (programmes?.length) return { programmes, matchType, matchedOn: candidate };
    }
  }

  return null;
}
