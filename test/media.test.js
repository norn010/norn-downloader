import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classify, cleanUrl, addItem, MAX_ITEMS, safeName, srcsetBest, mergeItems, pageVideos, videoIdFromUrl, pageVideoItems, hideFacebookPieces,
} from '../media.js';

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

// Same shape as the JSON Facebook embeds in <script type="application/json"> on a reel page.
// (the escaped percent sign is spliced in so no tool can pre-decode it)
const FB = String.raw`{"videoDeliveryLegacyFields":{"browser_native_sd_url":"https:\/\/video.fbcdn.test\/o1\/v\/sd.mp4?efg=eyJ9PCT3D&tag=progressive_h264-basic-gen2_360p","browser_native_hd_url":"https:\/\/video.fbcdn.test\/o1\/v\/hd.mp4?tag=progressive_h264-basic-gen2_720p","id":"1000000000000001"},"a":{"videoDeliveryLegacyFields":{"browser_native_sd_url":"https:\/\/video.fbcdn.test\/sd2.mp4","browser_native_hd_url":null,"id":"1000000000000002"}},"again":{"browser_native_sd_url":"https:\/\/video.fbcdn.test\/dup.mp4","browser_native_hd_url":null,"id":"1000000000000001"},"bad":{"browser_native_sd_url":"javascript:alert(1)","browser_native_hd_url":null,"id":"777"}}`.replace('PCT', '\\' + 'u0025');
const SD1 = 'https://video.fbcdn.test/o1/v/sd.mp4?efg=eyJ9%3D&tag=progressive_h264-basic-gen2_360p';
const HD1 = 'https://video.fbcdn.test/o1/v/hd.mp4?tag=progressive_h264-basic-gen2_720p';

test('pageVideos reads Facebook progressive URLs, unescapes them, one entry per id', () => {
  assert.deepEqual(pageVideos(FB), [
    { id: '1000000000000001', sd: SD1, hd: HD1 },
    { id: '1000000000000002', sd: 'https://video.fbcdn.test/sd2.mp4', hd: null },
    { id: '777', sd: 'javascript:alert(1)', hd: null },
  ]);
  assert.deepEqual(pageVideos('<html>nothing here</html>'), []);
});

test('videoIdFromUrl finds Facebook reel/video ids only', () => {
  assert.equal(videoIdFromUrl('https://www.facebook.com/reel/1000000000000001'), '1000000000000001');
  assert.equal(videoIdFromUrl('https://www.facebook.com/reel/1000000000000001/?s=ifu'), '1000000000000001');
  assert.equal(videoIdFromUrl('https://www.facebook.com/watch/?v=123456'), '123456');
  assert.equal(videoIdFromUrl('https://www.facebook.com/SomePage/videos/987654321/'), '987654321');
  assert.equal(videoIdFromUrl('https://www.youtube.com/watch?v=kJiHgFeDcBa'), null);
  assert.equal(videoIdFromUrl('https://www.facebook.com/'), null);
  assert.equal(videoIdFromUrl('https://m.facebook.com/reel/42'), '42');
  assert.equal(videoIdFromUrl('https://example.com/reel/1000000000000001'), null);
  assert.equal(videoIdFromUrl(undefined), null);
});

test('pageVideoItems: only the reel in the URL (never the preloaded next ones), HD first, named by id; http(s) only', () => {
  assert.deepEqual(pageVideoItems(FB, 'https://www.facebook.com/reel/1000000000000001'), [
    { url: HD1, kind: 'video', size: null, label: 'HD · with sound', filename: 'facebook-1000000000000001-hd.mp4' },
    { url: SD1, kind: 'video', size: null, label: 'SD · with sound', filename: 'facebook-1000000000000001-sd.mp4' },
  ]);
  assert.deepEqual(pageVideoItems(FB, 'https://www.facebook.com/').map(i => i.filename), [
    'facebook-1000000000000001-hd.mp4',
    'facebook-1000000000000001-sd.mp4',
    'facebook-1000000000000002-sd.mp4',
  ]);
  assert.deepEqual(pageVideoItems(FB, 'https://www.facebook.com/reel/999'), []);
});

test('hideFacebookPieces drops fbcdn video/audio pieces on Facebook pages only', () => {
  const items = [
    { url: 'https://video.fbkk22-4.fna.fbcdn.net/o1/v/t2/f2/m69/AQM.mp4?efg=x', kind: 'video' },
    { url: 'https://video.fbkk22-4.fna.fbcdn.net/o1/v/t2/f2/m69/AQN.mp4?efg=y', kind: 'audio' },
    { url: 'https://scontent.fbkk22-4.fna.fbcdn.net/v/photo.jpg', kind: 'image' },
    { url: 'https://cdn.example/clip.mp4', kind: 'video' },
  ];
  assert.deepEqual(hideFacebookPieces(items, 'https://www.facebook.com/reel/1').map(i => i.url), [
    'https://scontent.fbkk22-4.fna.fbcdn.net/v/photo.jpg',
    'https://cdn.example/clip.mp4',
  ]);
  assert.equal(hideFacebookPieces(items, 'https://example.com/').length, 4);
  assert.equal(hideFacebookPieces(items, undefined).length, 4);
});
