import test from 'node:test';
import assert from 'node:assert/strict';
import { classify, cleanUrl, addItem, MAX_ITEMS, safeName, srcsetBest, mergeItems } from '../media.js';

test('classify uses Content-Type first', () => {
  assert.equal(classify('https://a.test/x', 'image/webp'), 'image');
  assert.equal(classify('https://a.test/x', 'video/mp4; codecs="avc1"'), 'video');
  assert.equal(classify('https://a.test/x', 'audio/mpeg'), 'audio');
  assert.equal(classify('https://a.test/x', 'application/vnd.apple.mpegurl'), 'hls');
  assert.equal(classify('https://a.test/x', 'Application/X-MpegURL'), 'hls');
});

test('classify falls back to the URL extension', () => {
  assert.equal(classify('https://a.test/p/photo.JPG?w=1080'), 'image');
  assert.equal(classify('https://a.test/clip.mp4', 'application/octet-stream'), 'video');
  assert.equal(classify('https://a.test/song.m4a'), 'audio');
  assert.equal(classify('https://a.test/live/index.m3u8?token=1', 'text/plain'), 'hls');
});

test('classify ignores HLS segments and non-media', () => {
  assert.equal(classify('https://a.test/seg1.ts', 'video/mp2t'), null);
  assert.equal(classify('https://a.test/seg1.m4s', 'video/mp4'), null);
  assert.equal(classify('https://a.test/app.js', 'text/javascript'), null);
  assert.equal(classify('https://a.test/page', 'text/html'), null);
  assert.equal(classify('not a url'), null);
});

test('cleanUrl drops byte-range params and leaves the rest byte-identical', () => {
  assert.equal(
    cleanUrl('https://v.cdn.test/v.mp4?efg=eyJ2%3D&bytestart=0&byteend=999&oh=00_Ab%2Cc'),
    'https://v.cdn.test/v.mp4?efg=eyJ2%3D&oh=00_Ab%2Cc',
  );
  assert.equal(cleanUrl('https://v.cdn.test/v.mp4?oh=x&bytestart=1000&byteend=1999'), 'https://v.cdn.test/v.mp4?oh=x');
  assert.equal(cleanUrl('https://v.cdn.test/v.mp4?bytestart=0'), 'https://v.cdn.test/v.mp4');
  assert.equal(cleanUrl('https://a.test/x.jpg?w=1'), 'https://a.test/x.jpg?w=1');
});

test('addItem returns the same list when the URL is already there', () => {
  const items = [{ url: 'https://a.test/1.jpg' }];
  assert.equal(addItem(items, { url: 'https://a.test/1.jpg' }), items);
  assert.deepEqual(
    addItem(items, { url: 'https://a.test/2.jpg' }).map(i => i.url),
    ['https://a.test/1.jpg', 'https://a.test/2.jpg'],
  );
});

test('addItem keeps only the newest MAX_ITEMS', () => {
  let items = [];
  for (let n = 0; n < MAX_ITEMS + 5; n++) items = addItem(items, { url: `https://a.test/${n}.jpg` });
  assert.equal(items.length, MAX_ITEMS);
  assert.equal(items[0].url, 'https://a.test/5.jpg');
  assert.equal(items.at(-1).url, `https://a.test/${MAX_ITEMS + 4}.jpg`);
});

test('safeName makes tab titles safe for Windows filenames', () => {
  assert.equal(safeName('Reel: cats / dogs? "live" <1> | 2*'), 'Reel_ cats _ dogs_ _live_ _1_ _ 2_');
  assert.equal(safeName('C:\\temp\\clip'), 'C__temp_clip');
  assert.equal(safeName('  ..hidden..  '), 'hidden');
  assert.equal(safeName('วิดีโอ 🎬'), 'วิดีโอ 🎬');
  assert.equal(safeName(''), 'norn');
  assert.equal(safeName(undefined), 'norn');
  assert.equal(safeName('x'.repeat(300)).length, 100);
});

test('safeName strips what Chrome refuses: format chars, DEL/C1, leading ~ or Unicode spaces, device names', () => {
  assert.equal(safeName('Dev 👩‍💻 stream'), 'Dev 👩💻 stream'); // ZWJ removed
  assert.equal(safeName('ข่าว​วันนี้'), 'ข่าววันนี้'); // zero-width space, common on Thai sites
  assert.equal(safeName('‎title­'), 'title');
  assert.equal(safeName('x\x7Fy\x85z'), 'x_y_z');
  assert.equal(safeName('~temp'), 'temp');
  assert.equal(safeName('a~b'), 'a~b');
  assert.equal(safeName(' 　name '), 'name');
  assert.equal(safeName('CON'), '_CON');
  assert.equal(safeName('aux'), '_aux');
  assert.equal(safeName('nul.txt'), '_nul.txt');
  assert.equal(safeName('console'), 'console');
});

test('srcsetBest picks the largest candidate, URLs may contain commas', () => {
  assert.equal(srcsetBest('a.jpg 320w, b.jpg 1080w, c.jpg 640w'), 'b.jpg');
  assert.equal(srcsetBest('a.jpg 1x,b.jpg 2x'), 'b.jpg');
  assert.equal(
    srcsetBest('https://img.test/w_200,h_200/a.jpg 1x, https://img.test/w_400,h_400/a.jpg 2x'),
    'https://img.test/w_400,h_400/a.jpg',
  );
  assert.equal(srcsetBest('only.jpg'), 'only.jpg');
  assert.equal(srcsetBest('  '), null);
});

test('mergeItems: network newest first, then page finds; http(s) only; deduped after cleanUrl', () => {
  const net = [
    { url: 'https://a.test/old.jpg', kind: 'image', mime: 'image/jpeg', size: 5000 },
    { url: 'https://v.test/r.mp4?oh=1', kind: 'video', mime: 'video/mp4', size: 9000 },
  ];
  const scan = {
    base: 'https://a.test/page/',
    found: [
      { url: 'https://a.test/old.jpg', kind: 'image' },
      { url: 'https://v.test/r.mp4?oh=1&bytestart=0&byteend=9', kind: 'video' },
      { url: 'blob:https://a.test/123', kind: 'video' },
      { url: 'data:image/png;base64,AAAA', kind: 'image' },
      { url: 'javascript:alert(1)', kind: 'image' },
      { url: 'http://[bad', kind: 'image' },
      { url: 'https://a.test/stream/index.m3u8', kind: 'video' },
      { url: 'https://a.test/photo?id=7', kind: 'image' },
    ],
    srcsets: ['small.jpg 320w, big.jpg 1080w', '   '],
  };
  assert.deepEqual(mergeItems(net, scan), [
    { url: 'https://v.test/r.mp4?oh=1', kind: 'video', size: 9000 },
    { url: 'https://a.test/old.jpg', kind: 'image', size: 5000 },
    { url: 'https://a.test/stream/index.m3u8', kind: 'hls', size: null },
    { url: 'https://a.test/photo?id=7', kind: 'image', size: null },
    { url: 'https://a.test/page/big.jpg', kind: 'image', size: null },
  ]);
});
