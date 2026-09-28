// Pure helpers shared by background.js, popup.js and the Node tests. No chrome/DOM APIs here.

const EXT = {
  image: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'svg'],
  video: ['mp4', 'webm', 'mov', 'mkv'],
  audio: ['mp3', 'm4a', 'aac', 'ogg', 'wav', 'opus'],
};
const HLS_MIME = ['application/vnd.apple.mpegurl', 'application/x-mpegurl', 'audio/mpegurl', 'audio/x-mpegurl'];
const SEGMENT_MIME = ['video/mp2t', 'video/iso.segment'];
const SEGMENT_EXT = ['ts', 'm4s'];

function extOf(url) {
  try {
    return new URL(url).pathname.match(/\.([a-z0-9]+)$/i)?.[1].toLowerCase() ?? '';
  } catch {
    return '';
  }
}

// 'image' | 'video' | 'audio' | 'hls', or null for non-media and HLS segments.
export function classify(url, mime = '') {
  mime = mime.split(';')[0].trim().toLowerCase();
  const ext = extOf(url);
  if (HLS_MIME.includes(mime) || ext === 'm3u8') return 'hls';
  if (SEGMENT_MIME.includes(mime) || SEGMENT_EXT.includes(ext)) return null;
  const top = mime.split('/')[0];
  if (top === 'image' || top === 'video' || top === 'audio') return top;
  return Object.keys(EXT).find(kind => EXT[kind].includes(ext)) ?? null;
}

// IG/FB fetch one video as many ?bytestart=&byteend= pieces. Dropping those two params gives the
// whole file and collapses the pieces into one entry. String edit, so signed params keep their encoding.
export const cleanUrl = url =>
  url.replace(/(?<=[?&])(?:bytestart|byteend)=[^&#]*&?/g, '').replace(/[?&]$/, '');

export const MAX_ITEMS = 500; // ponytail: per-tab cap so infinite feeds can't fill storage.session (10 MB)

// Appends item unless its URL is already listed (then returns the same array). Keeps the newest MAX_ITEMS.
export function addItem(items, item) {
  if (items.some(i => i.url === item.url)) return items;
  return [...items, item].slice(-MAX_ITEMS);
}

// Tab title → filename Windows and Chrome accept. Counts code points so emoji aren't cut in half.
// Chrome also refuses format chars (ZWJ, zero-width space, LRM), a leading ~ or Unicode space, and device names.
export function safeName(title) {
  let name = Array.from(String(title ?? '').replace(/[\\/:*?"<>|\p{Cc}]/gu, '_').replace(/\p{Cf}/gu, ''))
    .slice(0, 100)
    .join('')
    .replace(/^[\p{White_Space}.~]+|[\p{White_Space}.]+$/gu, '');
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(name)) name = `_${name}`;
  return name || 'norn';
}

// Largest candidate by its w/x descriptor, parsed the way browsers do: a URL is a run of
// non-spaces (commas allowed inside); its descriptors run to the next comma.
export function srcsetBest(srcset) {
  let best = null;
  let bestSize = -1;
  let rest = srcset;
  while ((rest = rest.replace(/^[\s,]+/, ''))) {
    let url = rest.match(/^\S+/)[0];
    let desc = '';
    rest = rest.slice(url.length);
    if (url.endsWith(',')) url = url.replace(/,+$/, '');
    else {
      desc = rest.match(/^[^,]*/)[0];
      rest = rest.slice(desc.length);
    }
    const size = parseFloat(desc.match(/[\d.]+(?=[wx])/)?.[0] ?? '1');
    if (size > bestSize) {
      best = url;
      bestSize = size;
    }
  }
  return best;
}

// Popup list: network finds newest first (they carry sizes), then page finds, then the largest
// srcset candidate of each element. Only http(s), one entry per cleaned URL.
export function mergeItems(net, scan) {
  const out = new Map();
  const put = (url, kind, size = null) => {
    try {
      url = cleanUrl(new URL(url, scan.base).href);
    } catch {
      return;
    }
    if (kind && /^https?:/.test(url) && !out.has(url)) out.set(url, { url, kind, size });
  };
  for (const i of [...net].reverse()) put(i.url, i.kind, i.size);
  for (const i of scan.found) put(i.url, classify(i.url) ?? i.kind);
  for (const s of scan.srcsets) {
    const best = srcsetBest(s);
    if (best) put(best, 'image');
  }
  return [...out.values()];
}

// Facebook embeds a ready-made progressive MP4 (video + sound) per video in the page's JSON:
// {"browser_native_sd_url":"…","browser_native_hd_url":"…"|null,"id":"…"}. Returns [{ id, sd, hd }], one per id.
// ponytail: tied to Facebook's current key names; update this pattern when they change.
const FB_VIDEO =
  /"browser_native_sd_url":("(?:[^"\\]|\\.)*"|null),"browser_native_hd_url":("(?:[^"\\]|\\.)*"|null),"id":"(\d+)"/g;

export function pageVideos(text) {
  const out = new Map();
  for (const [, sd, hd, id] of text.matchAll(FB_VIDEO)) {
    if (!out.has(id)) out.set(id, { id, sd: JSON.parse(sd), hd: JSON.parse(hd) });
  }
  return [...out.values()];
}

const hostIs = (url, re) => {
  try {
    return re.test(new URL(url).hostname);
  } catch {
    return false;
  }
};
const FACEBOOK = /(^|\.)facebook\.com$/;

// Numeric video id from a Facebook /reel/<id>, /videos/<id> or ?v=<id> URL; null anywhere else.
export function videoIdFromUrl(url) {
  if (!hostIs(url, FACEBOOK)) return null;
  const u = new URL(url);
  const v = u.searchParams.get('v');
  return u.pathname.match(/\/(?:reel|videos)\/(\d+)/)?.[1] ?? (/^\d+$/.test(v) ? v : null);
}

// Popup items for the video the page is about: the id in its URL (never the preloaded next reels),
// else every one found. HD first; http(s) only.
export function pageVideoItems(text, pageUrl) {
  const id = videoIdFromUrl(pageUrl);
  return pageVideos(text)
    .filter(v => !id || v.id === id)
    .flatMap(v => [
      v.hd && { url: v.hd, kind: 'video', size: null, label: 'HD · with sound', filename: `facebook-${v.id}-hd.mp4` },
      v.sd && { url: v.sd, kind: 'video', size: null, label: 'SD · with sound', filename: `facebook-${v.id}-sd.mp4` },
    ])
    .filter(i => i && /^https?:/.test(i.url));
}

// On Facebook every fbcdn video/audio response is a DASH piece (video-only or audio-only, often of the
// next reel), which only confuses. The with-sound files come from pageVideoItems instead.
export const hideFacebookPieces = (items, pageUrl) =>
  hostIs(pageUrl, FACEBOOK)
    ? items.filter(i => !((i.kind === 'video' || i.kind === 'audio') && hostIs(i.url, /(^|\.)fbcdn\.net$/)))
    : items;
