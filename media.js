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
