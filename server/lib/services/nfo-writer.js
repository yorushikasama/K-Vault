/**
 * NFO sidecar generation, Kodi/Jellyfin/Plex shaped.
 *
 * yt-dlp has no NFO postprocessor — every project that ships NFO files writes
 * them itself, and ytdl-sub is the reference implementation for the field
 * mapping. This module does the same thing for one video at a time: take the
 * info dict yt-dlp already produced and emit the XML a media server expects.
 *
 * Two decisions worth stating:
 *
 * - Output is intentionally a subset. Kodi's schema has hundreds of elements and
 *   a media server ignores the ones it does not recognise; emitting the ~20 that
 *   are actually populated beats emitting 200 empty ones. Unknown values are
 *   omitted rather than written as empty tags, because an empty <plot/> shows up
 *   as a blank description while a missing one lets the scraper supply its own.
 * - Everything is escaped. Titles routinely contain `&`, `<` and quotes, and a
 *   malformed NFO makes the media server drop the whole item rather than the
 *   single field.
 */

const path = require('node:path');

// XML 1.0 forbids most control characters, even escaped. yt-dlp occasionally
// passes them through from a description, so they are stripped before escaping
// rather than producing a file no parser will accept.
const INVALID_XML_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

function escapeXml(value) {
  return String(value == null ? '' : value)
    .replace(INVALID_XML_CHARS, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function tag(name, value) {
  const text = String(value == null ? '' : value).trim();
  if (!text) return '';
  return `  <${name}>${escapeXml(text)}</${name}>\n`;
}

// Kodi reads `premiered` as a plain date; yt-dlp gives YYYYMMDD, which has to be
// turned into the ISO form. Reporting an invalid date is worse than reporting
// none, so anything unrecognised is dropped.
function toIsoDate(uploadDate) {
  const text = String(uploadDate || '').trim();
  const match = text.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (!match) return '';
  const [, year, month, day] = match;
  const monthNumber = Number(month);
  const dayNumber = Number(day);
  if (monthNumber < 1 || monthNumber > 12 || dayNumber < 1 || dayNumber > 31) return '';
  return `${year}-${month}-${day}`;
}

// Runtime is whole minutes in the NFO schema, rounded up so a 30-second clip
// does not report as 0 minutes.
function toRuntimeMinutes(duration) {
  const seconds = Number(duration);
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  return String(Math.max(1, Math.round(seconds / 60)));
}

// One <actor> block, which is how Kodi models an uploader. `role` is what makes
// Jellyfin show it under "Cast" rather than as a director.
function actorBlock(name) {
  const text = String(name || '').trim();
  if (!text) return '';
  return `  <actor>\n    <name>${escapeXml(text)}</name>\n    <role>Uploader</role>\n  </actor>\n`;
}

/**
 * Builds the NFO for one video entry.
 *
 * `episodeHint` is optional and used for playlist/channel results, where a
 * media server can only group the items if it is told they are episodes of a
 * season. Without it the file is written as a standalone movie, which is the
 * right shape for a single pasted link.
 */
function buildVideoNfo(entry, { episodeHint = null } = {}) {
  const info = entry && typeof entry === 'object' ? entry : {};

  const title = String(info.track || info.title || '').trim() || 'Untitled';
  const uploader = String(info.uploader || info.channel || info.creator || '').trim();
  const description = String(info.description || '').trim();
  const premiere = toIsoDate(info.upload_date);
  const runtime = toRuntimeMinutes(info.duration);
  const url = String(info.webpage_url || '').trim();
  const id = String(info.id || '').trim();

  let xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
  xml += '<movie>\n';
  xml += tag('title', title);

  if (episodeHint) {
    // Season/episode placement. A playlist has an implicit order and a channel
    // upload has a date; either way the server needs numbers, not a title.
    if (episodeHint.season !== undefined && episodeHint.season !== null) {
      xml += tag('season', String(episodeHint.season));
    }
    if (episodeHint.episode !== undefined && episodeHint.episode !== null) {
      xml += tag('episode', String(episodeHint.episode));
    }
    if (episodeHint.showTitle) xml += tag('showtitle', episodeHint.showTitle);
  } else {
    xml += tag('originaltitle', info.track || info.title);
  }

  xml += tag('plot', description);
  xml += tag('outline', description ? description.slice(0, 200) : '');
  xml += tag('premiered', premiere);
  xml += tag('aired', premiere);
  xml += tag('runtime', runtime);
  xml += tag('studio', uploader);
  xml += tag('director', uploader);
  xml += actorBlock(uploader);

  if (info.artist) xml += tag('artist', info.artist);
  if (info.album) xml += tag('album', info.album);
  if (info.track_number) xml += tag('track', String(info.track_number));

  xml += tag('uniqueid', id ? `${info.extractor_key || info.extractor || 'ytdlp'}:${id}` : '');
  xml += tag('source', url);
  xml += tag('website', url);

  // Categories and tags come from the platform's own taxonomy. Kodi accepts
  // repeated <genre>/<tag> elements, so each becomes its own line.
  for (const category of toStringArray(info.categories)) {
    xml += tag('genre', category);
  }
  for (const tagName of toStringArray(info.tags)) {
    xml += tag('tag', tagName);
  }

  // A thumbnail is what the media server shows; the actual image file is
  // written next to the media by yt-dlp and picked up by convention.
  const thumbnail = String(info.thumbnail || '').trim();
  if (thumbnail) xml += tag('thumb', thumbnail);

  xml += '</movie>\n';
  return xml;
}

function toStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item == null ? '' : item).trim())
    .filter(Boolean)
    .slice(0, 32);
}

/**
 * Where the NFO should live and what it should be called.
 *
 * Kodi matches a sidecar to its media by filename stem, so `<video>.nfo` is the
 * only name that works. A playlist producing several movies needs one file per
 * item, which is why the caller passes the stem in rather than this module
 * guessing from the title.
 */
function nfoFileName(mediaFileName) {
  const stem = path.basename(String(mediaFileName || 'video'))
    .replace(/\.[^.]+$/, '');
  return `${stem || 'video'}.nfo`;
}

module.exports = {
  buildVideoNfo,
  nfoFileName,
  escapeXml,
  toIsoDate,
  toRuntimeMinutes,
};
