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

// Facebook and Instagram play video as DASH (video-only + audio-only pieces), but their pages embed ready-made
// MP4s with sound in <script type="application/json"> blocks. `texts` holds those blocks; each is one JSON document.
// Shapes seen (2026-09-28):
//   Facebook, older:  {"browser_native_sd_url":…,"browser_native_hd_url":…|null,"id":"<video id>"}
//   Facebook, newer:  {…,"progressive_urls":[{"progressive_url":…,"metadata":{"quality":"SD"|"HD"}}],…,"id":…}
//   Instagram:        {"code":"<post code>",…,"video_versions":[{"width","height","url"}]} (carousel children
//                     carry video_versions without a code of their own)
// Returns [{ site, id, sd, hd }]: Facebook merged per id, Instagram one entry per video.
// ponytail: tied to these key names; add a shape here when a site changes them.
export function pageVideos(texts) {
  const out = [];
  const fb = new Map();
  const facebook = (id, sd, hd) => {
    const v = fb.get(id) ?? (out.push({ site: 'facebook', id, sd: null, hd: null }), fb.set(id, out.at(-1)).get(id));
    v.sd ??= typeof sd === 'string' ? sd : null;
    v.hd ??= typeof hd === 'string' ? hd : null;
  };
  const visit = (node, ctx) => {
    if (typeof node.id === 'string' && ('browser_native_sd_url' in node || 'browser_native_hd_url' in node)) {
      facebook(node.id, node.browser_native_sd_url, node.browser_native_hd_url);
    }
    if (typeof node.id === 'string' && Array.isArray(node.progressive_urls)) {
      const url = hd => node.progressive_urls.find(e => (e?.metadata?.quality === 'HD') === hd)?.progressive_url;
      facebook(node.id, url(false), url(true));
    }
    if (ctx.code && Array.isArray(node.video_versions)) {
      // story versions carry no size of their own; the item's original_width/height describe them
      const area = v => (v.width ?? 0) * (v.height ?? 0);
      const best = node.video_versions
        .filter(v => typeof v?.url === 'string')
        .reduce((a, b) => (!a || area(b) > area(a) ? b : a), null);
      if (best) {
        const hd = Math.min(best.width ?? node.original_width, best.height ?? node.original_height) >= 720;
        const pk = typeof node.pk === 'string' ? node.pk : null;
        const thumb = node.image_versions2?.candidates?.at(-1)?.url; // smallest cover image
        out.push({
          site: 'instagram', id: ctx.code, pk, sd: hd ? null : best.url, hd: hd ? best.url : null,
          ...(typeof thumb === 'string' && { thumb }),
          ...(ctx.reel && { reel: ctx.reel, index: ctx.index, reelSize: ctx.reelSize }),
        });
      }
    }
  };
  // TikTok: {"id":…,"video":{"cover":…,"bitrateInfo":[{"CodecType","PlayAddr":{"Width","Height","UrlList"}}]}}.
  // Every version is a complete MP4 with sound; the best may be H.265, so the best H.264 is offered too.
  const tiktok = node => {
    const size = b => (b.PlayAddr?.Width ?? 0) * (b.PlayAddr?.Height ?? 0);
    const url = b => b?.PlayAddr?.UrlList?.find(u => typeof u === 'string');
    const biggest = list => list.reduce((a, b) => (!a || size(b) > size(a) ? b : a), null);
    const usable = node.video.bitrateInfo.filter(url);
    const best = biggest(usable);
    if (!best) return;
    const isHd = Math.min(best.PlayAddr?.Width ?? 0, best.PlayAddr?.Height ?? 0) >= 720;
    const h264 = biggest(usable.filter(b => b.CodecType === 'h264' && size(b) < size(best)));
    out.push({
      site: 'tiktok', id: node.id,
      sd: isHd ? (url(h264) ?? null) : url(best),
      hd: isHd ? url(best) : null,
      ...(isHd && !/h264/.test(best.CodecType ?? '') && { hdNote: 'H.265' }),
      ...(typeof node.video.cover === 'string' && { thumb: node.video.cover }),
    });
  };
  // ctx: the nearest Instagram post code, and for highlight items their reel and position in it
  const walk = (node, ctx) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(x => walk(x, ctx));
    if (typeof node.code === 'string') ctx = { ...ctx, code: node.code };
    visit(node, ctx);
    if (typeof node.id === 'string' && Array.isArray(node.video?.bitrateInfo)) tiktok(node);
    const reel = typeof node.id === 'string' && node.id.startsWith('highlight:') && Array.isArray(node.items);
    for (const key in node) {
      if (reel && key === 'items') {
        node.items.forEach((item, index) => walk(item, { ...ctx, reel: node.id, index, reelSize: node.items.length }));
      } else walk(node[key], ctx);
    }
  };
  for (const text of texts) {
    try {
      walk(JSON.parse(text), {});
    } catch {
      // not a JSON document; skip it
    }
  }
  return out;
}

const hostIs = (url, re) => {
  try {
    return re.test(new URL(url).hostname);
  } catch {
    return false;
  }
};
const FACEBOOK = /(^|\.)facebook\.com$/;
const INSTAGRAM = /(^|\.)instagram\.com$/;
const TIKTOK = /(^|\.)tiktok\.com$/;

// The video a page is about: Facebook /reel/<id>, /videos/<id>, ?v=<id>; Instagram /p|reel|reels|tv/<code>,
// a story's number in /stories/<user>/<number>/, or "highlight:<id>" for /stories/highlights/<id>/.
// null anywhere else.
export function videoIdFromUrl(url) {
  if (hostIs(url, INSTAGRAM)) {
    const path = new URL(url).pathname;
    const highlight = path.match(/^\/stories\/highlights\/(\d+)/)?.[1];
    return (
      (highlight && `highlight:${highlight}`) ??
      path.match(/^\/(?:p|reels?|tv)\/([A-Za-z0-9_-]+)/)?.[1] ??
      path.match(/^\/stories\/(?!highlights\/)[^/]+\/(\d+)/)?.[1] ??
      null
    );
  }
  if (hostIs(url, TIKTOK)) return new URL(url).pathname.match(/^\/@[^/]+\/video\/(\d+)/)?.[1] ?? null;
  if (!hostIs(url, FACEBOOK)) return null;
  const u = new URL(url);
  const v = u.searchParams.get('v');
  return u.pathname.match(/\/(?:reel|videos)\/(\d+)/)?.[1] ?? (/^\d+$/.test(v) ? v : null);
}

// Popup items for the video the page is about (the id in its URL, never preloaded next ones), else every one
// found; for a highlight, all its videos numbered by position. HD first; http(s) only.
export function pageVideoItems(texts, pageUrl) {
  const id = videoIdFromUrl(pageUrl);
  const item = (v, q) => {
    const n = v.reel ? v.index + 1 : null;
    return {
      url: v[q],
      kind: 'video',
      size: null,
      label: `${n ? `#${n} · ` : ''}${q.toUpperCase()} · with sound${q === 'hd' && v.hdNote ? ` (${v.hdNote})` : ''}`,
      filename: n
        ? `${v.site}-highlight-${v.reel.slice('highlight:'.length)}-${n}-${q}.mp4`
        : `${v.site}-${id ?? v.id}-${q}.mp4`,
      ...(v.thumb && { thumb: v.thumb }),
      ...(v.reel && { index: v.index, reelSize: v.reelSize }),
      ...(v.site === 'tiktok' && { fetch: true }), // CDN needs a Referer, which chrome.downloads can't send
    };
  };
  const items = pageVideos(texts)
    .filter(v => !id || v.id === id || v.pk === id || v.reel === id)
    .flatMap(v => [v.hd && item(v, 'hd'), v.sd && item(v, 'sd')])
    .filter(i => i && /^https?:/.test(i.url));
  return [...new Map(items.map(i => [i.url, i])).values()]; // a page may carry the same video twice
}

// Highlights: put the item the viewer is on first. `position` = {count, index} read from the page's progress bar;
// ignored unless its segment count matches the highlight's size (and the item there is a video).
export function markCurrent(items, position) {
  if (!items.some(i => i.reelSize === position?.count && i.index === position?.index)) return items;
  const current = items
    .filter(i => i.index === position.index)
    .map(i => ({ ...i, label: i.label.replace(/^#\d+/, 'This story') }));
  return [...current, ...items.filter(i => i.index !== position.index)];
}

// On Facebook and Instagram every fbcdn/cdninstagram video or audio response is a DASH piece (video-only or
// audio-only, often of the next video); on TikTok they are the player's chunked copies of the files offered
// anyway. Either way they only confuse. The with-sound files come from pageVideoItems.
export const hideSitePieces = (items, pageUrl) =>
  [FACEBOOK, INSTAGRAM, TIKTOK].some(site => hostIs(pageUrl, site))
    ? items.filter(
        i =>
          !(
            (i.kind === 'video' || i.kind === 'audio') &&
            hostIs(i.url, /(^|\.)(fbcdn\.net|cdninstagram\.com|tiktok\.com|tiktokcdn(-[a-z]+)?\.com)$/)
          ),
      )
    : items;
