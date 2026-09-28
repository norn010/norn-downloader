import { parse, pickBest, fetchInOrder, liveEdge } from './hls.js';

const send = msg => chrome.runtime.sendMessage(msg);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ponytail: no Referer is sent; CDNs that check it answer 403. Add a declarativeNetRequest header rule if needed.
async function get(url, as = 'arrayBuffer') {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { credentials: 'include' });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res[as]();
    } catch (e) {
      if (attempt >= 3) throw e;
      await sleep(500 * attempt);
    }
  }
}

// Offscreen can't use chrome.downloads; background saves the blob URL and asks us to revoke it after.
const save = (parts, name, ext) =>
  send({ type: 'save', url: URL.createObjectURL(new Blob(parts)), filename: `${name}.${ext}` });

// Master playlist → best variant. Returns the media playlist and its URL.
async function mediaPlaylist(url) {
  let p = parse(await get(url, 'text'), url);
  if (p.master) {
    url = pickBest(p.variants).url;
    p = parse(await get(url, 'text'), url);
  }
  if (p.unsupported) throw new Error(`${p.unsupported} — use Record tab instead`);
  return { p, url };
}

async function hls(url, name) {
  const { p, url: mediaUrl } = await mediaPlaylist(url);
  return p.ended ? vod(p, name) : live(p, mediaUrl, name);
}

async function vod(p, name) {
  const parts = await fetchInOrder(
    p.segments.map(s => s.url),
    get,
    (done, total) => send({ type: 'progress', text: `${Math.floor((done * 100) / total)}%` }),
  );
  if (p.map) parts.unshift(await get(p.map));
  // ponytail: the whole file is one in-memory Blob (Chrome spills big blobs to disk); stream to disk for multi-GB
  await save(parts, name, p.map ? 'mp4' : 'ts');
}

const liveStops = new Set();

async function live(p, url, name) {
  const parts = p.map ? [await get(p.map)] : [];
  const ext = p.map ? 'mp4' : 'ts';
  let stopped = false;
  let last = liveEdge(p.segments);
  const firstSeq = last;
  const stop = () => (stopped = true);
  liveStops.add(stop);
  await send({ type: 'status', patch: { live: true } });
  try {
    while (true) {
      for (const s of p.segments) {
        if (s.seq > last) {
          parts.push(await get(s.url));
          last = s.seq;
        }
      }
      if (stopped || p.ended) break;
      await sleep((p.targetDuration || 2) * 1000);
      if (stopped) break;
      p = parse(await get(url, 'text'), url);
    }
  } finally {
    liveStops.delete(stop);
    await send({ type: 'status', patch: { live: liveStops.size > 0 } });
    if (last > firstSeq) await save(parts, name, ext); // keep what was captured even if the loop failed
  }
}

function stop(what) {
  if (what === 'live') liveStops.forEach(s => s());
}

const jobs = {
  hls: m => hls(m.url, m.name),
  stop: m => stop(m.what),
  revoke: m => URL.revokeObjectURL(m.url),
};

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg.target !== 'offscreen') return;
  reply(); // ack now; results come back as separate messages
  Promise.resolve()
    .then(() => jobs[msg.type]?.(msg))
    .catch(e => send({ type: 'error', message: e.message }));
});
