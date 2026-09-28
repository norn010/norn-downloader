import test from 'node:test';
import assert from 'node:assert/strict';
import { parse, pickBest, fetchInOrder, liveEdge } from '../hls.js';

const BASE = 'https://cdn.test/v/master.m3u8?token=abc';
const MASTER = [
  '#EXTM3U',
  '#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2"',
  '720p/index.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1.4d401e,mp4a.40.2"',
  '360p/index.m3u8',
  '#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=90000,URI="iframe.m3u8"',
].join('\n');
const media = (...lines) =>
  ['#EXTM3U', '#EXT-X-TARGETDURATION:6', '#EXT-X-MEDIA-SEQUENCE:10', ...lines].join('\r\n');
const SEGS = ['#EXTINF:6.0,', 'seg10.ts', '#EXTINF:6.0,', 'https://other.test/seg11.ts'];

test('rejects text that is not a playlist', () => {
  assert.throws(() => parse('<html></html>', BASE), /Not an HLS playlist/);
});

test('master: variants resolved against the playlist URL, quoted commas survive, I-frame lists ignored', () => {
  const p = parse(MASTER, BASE);
  assert.equal(p.master, true);
  assert.deepEqual(p.variants, [
    { url: 'https://cdn.test/v/720p/index.m3u8', bandwidth: 2500000 },
    { url: 'https://cdn.test/v/360p/index.m3u8', bandwidth: 800000 },
  ]);
  assert.deepEqual(p.segments, []);
});

test('pickBest takes the highest bandwidth wherever it is listed', () => {
  const best = pickBest([{ url: 'a', bandwidth: 1 }, { url: 'b', bandwidth: 3 }, { url: 'c', bandwidth: 2 }]);
  assert.equal(best.url, 'b');
});

test('media VOD: absolute segment URLs numbered from MEDIA-SEQUENCE, CRLF endings', () => {
  const p = parse(media(...SEGS, '#EXT-X-ENDLIST'), 'https://cdn.test/v/720p/index.m3u8');
  assert.equal(p.master, false);
  assert.deepEqual(p.segments, [
    { url: 'https://cdn.test/v/720p/seg10.ts', seq: 10 },
    { url: 'https://other.test/seg11.ts', seq: 11 },
  ]);
  assert.equal(p.targetDuration, 6);
  assert.equal(p.ended, true);
  assert.equal(p.map, null);
  assert.equal(p.unsupported, null);
});

test('live playlist has no ENDLIST', () => {
  assert.equal(parse(media(...SEGS), BASE).ended, false);
});

test('fMP4: EXT-X-MAP init segment resolved', () => {
  assert.equal(parse(media('#EXT-X-MAP:URI="init.mp4"', ...SEGS), BASE).map, 'https://cdn.test/v/init.mp4');
});

test('encrypted and byte-range playlists are flagged unsupported', () => {
  assert.equal(parse(media('#EXT-X-KEY:METHOD=AES-128,URI="k.bin"', ...SEGS), BASE).unsupported, 'Encrypted stream');
  assert.equal(parse(media('#EXT-X-KEY:METHOD=NONE', ...SEGS), BASE).unsupported, null);
  assert.equal(
    parse(media('#EXTINF:6.0,', '#EXT-X-BYTERANGE:1000@0', 'all.ts'), BASE).unsupported,
    'Byte-range playlist',
  );
});

test('liveEdge: live capture starts three segments from the end, not at the start of the DVR window', () => {
  const segs = n => Array.from({ length: n }, (_, i) => ({ url: `s${i}`, seq: 100 + i }));
  const firstTaken = list => list.find(s => s.seq > liveEdge(list))?.seq;
  assert.equal(firstTaken(segs(300)), 397);
  assert.equal(firstTaken(segs(3)), 100);
  assert.equal(firstTaken(segs(1)), 100);
  assert.equal(liveEdge([]), -1);
});

const delay = ms => new Promise(r => setTimeout(r, ms));

test('fetchInOrder returns results in input order and reports progress', async () => {
  const urls = ['a', 'b', 'c', 'd', 'e'];
  const progress = [];
  const get = async u => { await delay(20 - urls.indexOf(u) * 4); return u.toUpperCase(); };
  const out = await fetchInOrder(urls, get, (done, total) => progress.push([done, total]), 2);
  assert.deepEqual(out, ['A', 'B', 'C', 'D', 'E']);
  assert.equal(progress.length, 5);
  assert.deepEqual(progress.at(-1), [5, 5]);
});

test('fetchInOrder stops starting fetches and reporting progress after the first failure', async () => {
  const urls = Array.from({ length: 20 }, (_, i) => String(i));
  let calls = 0;
  const progress = [];
  const get = async u => {
    calls++;
    await delay(5);
    if (u === '3') throw new Error('HTTP 403 for 3');
    return u;
  };
  await assert.rejects(fetchInOrder(urls, get, n => progress.push(n), 2), /HTTP 403/);
  const seen = progress.length;
  await delay(50);
  assert.ok(calls < urls.length, `started ${calls} fetches`);
  assert.equal(progress.length, seen, 'no progress after failure');
});

test('fetchInOrder with no URLs resolves to []', async () => {
  assert.deepEqual(await fetchInOrder([], async () => 1), []);
});
