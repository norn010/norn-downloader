// Pure m3u8 parsing and an ordered download pool. No chrome/DOM APIs, so Node tests can import it.

// Attribute list after the first ':' — quoted values may contain commas.
function attrs(line) {
  const out = {};
  for (const [, key, value] of line.slice(line.indexOf(':') + 1).matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g)) {
    out[key] = value.replace(/^"|"$/g, '');
  }
  return out;
}

const num = line => Number(line.slice(line.indexOf(':') + 1));

export function parse(text, baseUrl) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (lines[0] !== '#EXTM3U') throw new Error('Not an HLS playlist');
  const abs = url => new URL(url, baseUrl).href;
  const p = { master: false, variants: [], segments: [], map: null, targetDuration: 0, ended: false, unsupported: null };
  let firstSeq = 0;
  let variant = null;
  for (const line of lines) {
    if (line.startsWith('#EXT-X-STREAM-INF:')) variant = attrs(line);
    else if (line.startsWith('#EXT-X-TARGETDURATION:')) p.targetDuration = num(line);
    else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) firstSeq = num(line);
    else if (line.startsWith('#EXT-X-MAP:')) p.map = abs(attrs(line).URI);
    else if (line.startsWith('#EXT-X-KEY:') && attrs(line).METHOD !== 'NONE') p.unsupported = 'Encrypted stream';
    else if (line.startsWith('#EXT-X-BYTERANGE')) p.unsupported ??= 'Byte-range playlist';
    else if (line === '#EXT-X-ENDLIST') p.ended = true;
    else if (line.startsWith('#')) continue;
    else if (variant) {
      p.variants.push({ url: abs(line), bandwidth: Number(variant.BANDWIDTH) || 0 });
      variant = null;
    } else p.segments.push({ url: abs(line), seq: firstSeq + p.segments.length });
  }
  p.master = p.variants.length > 0;
  return p;
}

// ponytail: separate audio renditions (EXT-X-MEDIA TYPE=AUDIO) are ignored, such streams save video-only;
// merge the audio playlist in if that matters.
export const pickBest = variants => variants.reduce((a, b) => (b.bandwidth > a.bandwidth ? b : a));

// get(url) for every url, at most `limit` in flight, results in input order.
// After the first failure: no new fetches, no more onEach calls, and the promise rejects with it.
export async function fetchInOrder(urls, get, onEach = () => {}, limit = 6) {
  const out = new Array(urls.length);
  let next = 0;
  let done = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && next < urls.length) {
      const i = next++;
      try {
        out[i] = await get(urls[i]);
      } catch (e) {
        failed = true;
        throw e;
      }
      if (!failed) onEach(++done, urls.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, urls.length) }, worker));
  return out;
}
