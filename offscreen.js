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

let recorder = null;

async function record(streamId, name) {
  if (recorder) throw new Error('Already recording a tab');
  const tab = { chromeMediaSource: 'tab', chromeMediaSourceId: streamId };
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: tab },
    // calibration knob: Chrome captures tabs small unless given max sizes
    video: { mandatory: { ...tab, maxWidth: 1920, maxHeight: 1080, maxFrameRate: 30 } },
  });
  const audio = new AudioContext();
  audio.createMediaStreamSource(stream).connect(audio.destination); // capturing mutes the tab; play it back
  const chunks = [];
  // VP8/Opus: every Chrome build encodes it. avc1 and VP9 pass isTypeSupported yet recorded nothing in testing.
  // calibration knob: videoBitsPerSecond (Chrome's default ~2.5 Mbps looks blocky at 1080p)
  recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8,opus', videoBitsPerSecond: 8e6 });
  recorder.ondataavailable = e => e.data.size && chunks.push(e.data);
  recorder.onerror = e => send({ type: 'error', message: `Recording failed: ${e.error?.message ?? 'unknown error'}` });
  recorder.onstop = async () => {
    stream.getTracks().forEach(t => t.stop());
    audio.close();
    recorder = null;
    await send({ type: 'status', patch: { recording: false } });
    if (chunks.length) await save(chunks, name, 'webm'); // never hand the user an empty file
  };
  // tab closed or navigated to an uncapturable page → finish and save
  stream.getVideoTracks()[0].onended = () => recorder?.state === 'recording' && recorder.stop();
  recorder.start();
  await send({ type: 'status', patch: { recording: true } });
}

function stop(what) {
  if (what === 'record') {
    if (recorder?.state === 'recording') recorder.stop();
  } else liveStops.forEach(s => s());
}

const jobs = {
  hls: m => hls(m.url, m.name),
  record: m => record(m.streamId, m.name),
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
