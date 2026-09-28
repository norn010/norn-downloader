import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classify, cleanUrl, addItem, MAX_ITEMS, safeName, srcsetBest, mergeItems, pageVideos, videoIdFromUrl, pageVideoItems, hideSitePieces, markCurrent, syndicationUrl,
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

// Page data comes as the text of each <script type="application/json"> block; each block is one JSON document.

// Older Facebook shape (logged out): videoDeliveryLegacyFields with browser_native_*_url.
// (the escaped percent sign is spliced in so no tool can pre-decode it)
const FB = String.raw`{"videoDeliveryLegacyFields":{"browser_native_sd_url":"https:\/\/video.fbcdn.test\/o1\/v\/sd.mp4?efg=eyJ9PCT3D&tag=progressive_h264-basic-gen2_360p","browser_native_hd_url":"https:\/\/video.fbcdn.test\/o1\/v\/hd.mp4?tag=progressive_h264-basic-gen2_720p","id":"1000000000000001"},"a":{"videoDeliveryLegacyFields":{"browser_native_sd_url":"https:\/\/video.fbcdn.test\/sd2.mp4","browser_native_hd_url":null,"id":"1000000000000002"}},"again":{"browser_native_sd_url":"https:\/\/video.fbcdn.test\/dup.mp4","browser_native_hd_url":null,"id":"1000000000000001"},"bad":{"browser_native_sd_url":"javascript:alert(1)","browser_native_hd_url":null,"id":"777"}}`.replace('PCT', '\\' + 'u0025');
const SD1 = 'https://video.fbcdn.test/o1/v/sd.mp4?efg=eyJ9%3D&tag=progressive_h264-basic-gen2_360p';
const HD1 = 'https://video.fbcdn.test/o1/v/hd.mp4?tag=progressive_h264-basic-gen2_720p';

// Newer Facebook shape (logged in, verified 2026-09-28): progressive_urls with quality labels; id after them.
const FB_NEW = String.raw`{"data":{"videoDeliveryResponseFragment":{"videoDeliveryResponseResult":{"dash_manifests":[{"manifest_xml":"<MPD>[x]{y}</MPD>"}],"dash_manifest_urls":[],"progressive_urls":[{"progressive_url":"https:\/\/video.fbcdn.test\/n\/sd.mp4?tag=progressive_h264-basic-gen2_360p","failure_reason":null,"metadata":{"quality":"SD"}},{"progressive_url":"https:\/\/video.fbcdn.test\/n\/hd.mp4?tag=progressive_h264-basic-gen2_720p","failure_reason":null,"metadata":{"quality":"HD"}}],"hls_playlist_urls":[{"url":"x","metadata":{"id":"999"}}],"id":"1000000000000001"}}},"next":{"progressive_urls":[{"progressive_url":"https:\/\/video.fbcdn.test\/n\/sd2.mp4?tag=sve_sd","failure_reason":null,"metadata":{"quality":"SD"}}],"id":"1000000000000003"}}`;

// Instagram (verified 2026-09-28): media objects carry "code" (the URL shortcode) before video_versions;
// carousel children have video_versions but no code of their own.
const IG = JSON.stringify({
  require: [['ScheduledServerJS', { items: [
    { code: 'AbCdEfGhIjK', pk: '1', media_type: 2, has_audio: true, video_versions: [
      { type: 101, width: 720, height: 1280, url: 'https://instagram.fbkk.test/v/t16/a.mp4?efg=1' },
      { type: 102, width: 480, height: 854, url: 'https://instagram.fbkk.test/v/t16/b.mp4' },
    ] },
    { code: 'CAROUSEL1', carousel_media: [
      { pk: '2', video_versions: [{ width: 1080, height: 1920, url: 'https://instagram.fbkk.test/c1.mp4' }] },
      { pk: '3', video_versions: [{ width: 540, height: 960, url: 'https://instagram.fbkk.test/c2.mp4' }] },
      { pk: '4', image_versions2: { candidates: [] } },
    ] },
  ] }]],
});

test('pageVideos reads older Facebook data, unescapes it, one entry per id', () => {
  assert.deepEqual(pageVideos([FB]), [
    { site: 'facebook', id: '1000000000000001', sd: SD1, hd: HD1 },
    { site: 'facebook', id: '1000000000000002', sd: 'https://video.fbcdn.test/sd2.mp4', hd: null },
    { site: 'facebook', id: '777', sd: 'javascript:alert(1)', hd: null },
  ]);
  assert.deepEqual(pageVideos(['{"nothing":"here"}']), []);
});

test('pageVideos reads the newer Facebook progressive_urls shape; nested ids are not the video id', () => {
  assert.deepEqual(pageVideos([FB_NEW]), [
    {
      site: 'facebook',
      id: '1000000000000001',
      sd: 'https://video.fbcdn.test/n/sd.mp4?tag=progressive_h264-basic-gen2_360p',
      hd: 'https://video.fbcdn.test/n/hd.mp4?tag=progressive_h264-basic-gen2_720p',
    },
    { site: 'facebook', id: '1000000000000003', sd: 'https://video.fbcdn.test/n/sd2.mp4?tag=sve_sd', hd: null },
  ]);
});

test('pageVideos merges both Facebook shapes per id and skips blocks that are not valid JSON', () => {
  const both = pageVideos(['{"progressive_urls":[{"progressive_url":"https:\\/\\/x', FB, FB_NEW]);
  assert.equal(both.filter(v => v.id === '1000000000000001').length, 1);
  assert.deepEqual(both.find(v => v.id === '1000000000000001'), { site: 'facebook', id: '1000000000000001', sd: SD1, hd: HD1 });
  assert.equal(both.find(v => v.id === '1000000000000003').sd, 'https://video.fbcdn.test/n/sd2.mp4?tag=sve_sd');
});

test('pageVideos reads Instagram video_versions: largest version, one entry per video, carousel children under the post code', () => {
  assert.deepEqual(pageVideos([IG]), [
    { site: 'instagram', id: 'AbCdEfGhIjK', pk: '1', sd: null, hd: 'https://instagram.fbkk.test/v/t16/a.mp4?efg=1' },
    { site: 'instagram', id: 'CAROUSEL1', pk: '2', sd: null, hd: 'https://instagram.fbkk.test/c1.mp4' },
    { site: 'instagram', id: 'CAROUSEL1', pk: '3', sd: 'https://instagram.fbkk.test/c2.mp4', hd: null },
  ]);
});

// Instagram story (verified 2026-09-28): items under reels_media, matched by pk (the number in the URL);
// video_versions carry no width/height, the item's original_width/height do.
const IG_STORY = JSON.stringify({ require: [[{ __bbox: { result: { data: { xdt_api__v1__feed__reels_media: { reels_media: [{
  user: { username: 'someone' },
  items: [
    { id: '3000000000000000105_2000000001', pk: '3000000000000000105', code: 'DXs1', media_type: 2, product_type: 'story',
      original_width: 720, original_height: 1280,
      video_versions: [{ type: 101, url: 'https://instagram.fbkk.test/s/one.mp4' }, { type: 102, url: 'https://instagram.fbkk.test/s/one.mp4?v=2' }] },
    { id: '3000000000000000106_2000000001', pk: '3000000000000000106', code: 'DXs2', media_type: 2, product_type: 'story',
      original_width: 480, original_height: 854, video_versions: [{ type: 101, url: 'https://instagram.fbkk.test/s/two.mp4' }] },
    { id: '3000000000000000107_2000000001', pk: '3000000000000000107', code: 'DXs3', media_type: 1, product_type: 'story',
      image_versions2: { candidates: [{ url: 'https://instagram.fbkk.test/s/photo.jpg' }] } },
  ],
}] } } } } }]] });

test('pageVideos reads Instagram stories: pk kept, size from original_width/height when versions have none', () => {
  assert.deepEqual(pageVideos([IG_STORY]), [
    { site: 'instagram', id: 'DXs1', pk: '3000000000000000105', sd: null, hd: 'https://instagram.fbkk.test/s/one.mp4' },
    { site: 'instagram', id: 'DXs2', pk: '3000000000000000106', sd: 'https://instagram.fbkk.test/s/two.mp4', hd: null },
  ]);
});

test('pageVideoItems: the story in the URL only, named by its number', () => {
  assert.deepEqual(pageVideoItems([IG_STORY], 'https://www.instagram.com/stories/someone/3000000000000000105/'), [
    {
      url: 'https://instagram.fbkk.test/s/one.mp4', kind: 'video', size: null,
      label: 'HD · with sound', filename: 'instagram-3000000000000000105-hd.mp4',
    },
  ]);
  assert.deepEqual(pageVideoItems([IG_STORY], 'https://www.instagram.com/stories/someone/1/'), []);
});

// Instagram highlight (verified 2026-09-28): one reel "highlight:<id>" with its items in viewing order; photo items
// have no video_versions but still count as a progress-bar segment.
const IG_HIGHLIGHT = JSON.stringify({ data: { xdt_api__v1__feed__reels_media__connection: { edges: [{ node: {
  id: 'highlight:18000000000000001', title: 'x', items: [
    { pk: '101', code: 'H1', media_type: 2, original_width: 720, original_height: 1280,
      image_versions2: { candidates: [{ width: 720, url: 'https://ig.test/h1-big.jpg' }, { width: 150, url: 'https://ig.test/h1-small.jpg' }] },
      video_versions: [{ type: 101, url: 'https://ig.test/h1.mp4' }] },
    { pk: '102', code: 'H2', media_type: 1, image_versions2: { candidates: [{ width: 150, url: 'https://ig.test/h2.jpg' }] } },
    { pk: '103', code: 'H3', media_type: 2, original_width: 1080, original_height: 1920,
      video_versions: [{ type: 101, url: 'https://ig.test/h3.mp4' }] },
  ],
} }] } } });
const HL_URL = 'https://www.instagram.com/stories/highlights/18000000000000001/';

test('pageVideos reads highlight items with their place in the highlight, and a cover thumbnail', () => {
  assert.deepEqual(pageVideos([IG_HIGHLIGHT]), [
    { site: 'instagram', id: 'H1', pk: '101', sd: null, hd: 'https://ig.test/h1.mp4', thumb: 'https://ig.test/h1-small.jpg',
      reel: 'highlight:18000000000000001', index: 0, reelSize: 3 },
    { site: 'instagram', id: 'H3', pk: '103', sd: null, hd: 'https://ig.test/h3.mp4',
      reel: 'highlight:18000000000000001', index: 2, reelSize: 3 },
  ]);
});

test('pageVideoItems lists every video of the highlight in the URL, numbered by position', () => {
  const items = pageVideoItems([IG_HIGHLIGHT], HL_URL);
  assert.deepEqual(items.map(i => [i.label, i.filename, i.index, i.reelSize]), [
    ['#1 · HD · with sound', 'instagram-highlight-18000000000000001-1-hd.mp4', 0, 3],
    ['#3 · HD · with sound', 'instagram-highlight-18000000000000001-3-hd.mp4', 2, 3],
  ]);
  assert.equal(items[0].thumb, 'https://ig.test/h1-small.jpg');
  assert.deepEqual(pageVideoItems([IG_HIGHLIGHT], 'https://www.instagram.com/stories/highlights/1/'), []);
});

test('markCurrent puts the item the viewer is on first, only when the progress bar matches the highlight', () => {
  const items = pageVideoItems([IG_HIGHLIGHT], HL_URL);
  assert.deepEqual(markCurrent(items, { count: 3, index: 2 }).map(i => i.label), [
    'This story · HD · with sound',
    '#1 · HD · with sound',
  ]);
  assert.equal(markCurrent(items, { count: 53, index: 2 }), items); // bar belongs to something else
  assert.equal(markCurrent(items, { count: 3, index: 1 }), items); // current item is a photo
  assert.equal(markCurrent(items, null), items);
});

// TikTok (verified 2026-09-28): __UNIVERSAL_DATA_FOR_REHYDRATION__ → webapp.video-detail.itemInfo.itemStruct;
// video.bitrateInfo lists complete MP4s with sound. The video node itself also has an id and bitrateInfo.
const TT_ID = '7000000000000000001';
const TT = JSON.stringify({ __DEFAULT_SCOPE__: { 'webapp.video-detail': { statusCode: 0, itemInfo: { itemStruct: {
  id: TT_ID, author: { uniqueId: 'somecreator' },
  video: {
    id: TT_ID, playAddr: 'https://v16.test/play540.mp4', downloadAddr: 'https://webapp-sg.test/watermarked',
    cover: 'https://p16.test/cover.jpeg',
    bitrateInfo: [
      { GearName: 'adapt_lowest_1080_1', CodecType: 'h265_hvc1', PlayAddr: { Width: 1080, Height: 1920, UrlList: ['https://v16.test/1080.mp4', 'https://v19.test/1080.mp4'] } },
      { GearName: 'lower_540_0', CodecType: 'h264', PlayAddr: { Width: 576, Height: 1024, UrlList: ['https://v16.test/540.mp4'] } },
      { GearName: 'adapt_lower_720_1', CodecType: 'h265_hvc1', PlayAddr: { Width: 720, Height: 1280, UrlList: ['https://v16.test/720.mp4'] } },
    ],
  },
} } } } });
const TT_H264_ONLY = JSON.stringify({ itemStruct: { id: '111', video: { cover: 'https://p16.test/c2.jpeg', bitrateInfo: [
  { CodecType: 'h264', PlayAddr: { Width: 720, Height: 1280, UrlList: ['https://v16.test/only.mp4'] } },
] } } });

test('pageVideos reads TikTok bitrateInfo: best version as HD (H.265 noted), best H.264 as SD, cover as thumbnail', () => {
  assert.deepEqual(pageVideos([TT, TT_H264_ONLY]), [
    { site: 'tiktok', id: TT_ID, sd: 'https://v16.test/540.mp4', hd: 'https://v16.test/1080.mp4', hdNote: 'H.265', thumb: 'https://p16.test/cover.jpeg' },
    { site: 'tiktok', id: '111', sd: null, hd: 'https://v16.test/only.mp4', thumb: 'https://p16.test/c2.jpeg' },
  ]);
});

test('pageVideoItems: TikTok video in the URL, H.265 noted on HD', () => {
  const items = pageVideoItems([TT, TT_H264_ONLY], `https://www.tiktok.com/@somecreator/video/${TT_ID}?is_from_webapp=1&sender_device=pc`);
  assert.deepEqual(items.map(i => [i.label, i.filename, i.thumb]), [
    ['HD · with sound (H.265)', `tiktok-${TT_ID}-hd.mp4`, 'https://p16.test/cover.jpeg'],
    ['SD · with sound', `tiktok-${TT_ID}-sd.mp4`, 'https://p16.test/cover.jpeg'],
  ]);
  // TikTok's CDN refuses chrome.downloads (no Referer possible), so these go through the extension's fetch
  assert.ok(items.every(i => i.fetch === true));
  assert.ok(pageVideoItems([IG_STORY], 'https://www.instagram.com/stories/someone/3000000000000000105/').every(i => !('fetch' in i)));
});

test('pageVideoItems lists a video once even when the page repeats it', () => {
  assert.equal(pageVideoItems([TT, TT], `https://www.tiktok.com/@somecreator/video/${TT_ID}`).length, 2);
});

// X (verified 2026-09-28): cdn.syndication.twimg.com/tweet-result JSON. Tweets are {"__typename":"Tweet","id_str"},
// videos sit in mediaDetails[] with video_info.variants (MP4s with sound + an HLS playlist); quoted tweets nest.
const X_ID = '2000000000000000001';
const mp4 = (bitrate, size, name) => ({ bitrate, content_type: 'video/mp4', url: `https://video.twimg.com/ext_tw_video/1/pu/vid/avc1/${size}/${name}.mp4?tag=12` });
const X_TWEET = JSON.stringify({
  __typename: 'Tweet', id_str: X_ID,
  mediaDetails: [{
    type: 'video', media_url_https: 'https://pbs.twimg.com/ext_tw_video_thumb/1/pu/img/t.jpg', original_info: { width: 2160, height: 2810 },
    video_info: { variants: [
      { content_type: 'application/x-mpegURL', url: 'https://video.twimg.com/ext_tw_video/1/pu/pl/x.m3u8' },
      mp4(632000, '320x416', 'a'), mp4(950000, '480x624', 'b'), mp4(2176000, '720x936', 'c'),
      mp4(10368000, '1080x1404', 'd'), mp4(25128000, '2160x2810', 'e'),
    ] },
  }],
  quoted_tweet: { __typename: 'Tweet', id_str: '999', mediaDetails: [{ type: 'video', video_info: { variants: [mp4(832000, '640x360', 'q')] } }] },
});
const X_MULTI = JSON.stringify({ __typename: 'Tweet', id_str: '555', mediaDetails: [
  { type: 'video', video_info: { variants: [mp4(2176000, '1280x720', 'v1')] } },
  { type: 'animated_gif', video_info: { variants: [{ bitrate: 0, content_type: 'video/mp4', url: 'https://video.twimg.com/tweet_video/g.mp4' }] } },
  { type: 'video', video_info: { variants: [mp4(832000, '640x360', 'v2')] } },
] });

test('pageVideos reads X tweets: highest bitrate as HD, largest below 720p as SD, quoted tweets under their own id', () => {
  assert.deepEqual(pageVideos([X_TWEET]), [
    {
      site: 'x', id: X_ID,
      hd: 'https://video.twimg.com/ext_tw_video/1/pu/vid/avc1/2160x2810/e.mp4?tag=12',
      sd: 'https://video.twimg.com/ext_tw_video/1/pu/vid/avc1/480x624/b.mp4?tag=12',
      thumb: 'https://pbs.twimg.com/ext_tw_video_thumb/1/pu/img/t.jpg',
      hls: 'https://video.twimg.com/ext_tw_video/1/pu/pl/x.m3u8',
    },
    { site: 'x', id: '999', hd: null, sd: 'https://video.twimg.com/ext_tw_video/1/pu/vid/avc1/640x360/q.mp4?tag=12' },
  ]);
});

test('pageVideoItems: X tweet with several videos numbers them; GIFs say they have no sound', () => {
  assert.deepEqual(pageVideoItems([X_MULTI], 'https://x.com/someone/status/555').map(i => [i.label, i.filename]), [
    ['#1 · HD · with sound', 'x-555-1-hd.mp4'],
    ['#2 · GIF (no sound)', 'x-555-2-gif.mp4'],
    ['#3 · SD · with sound', 'x-555-3-sd.mp4'],
  ]);
  assert.deepEqual(pageVideoItems([X_TWEET], `https://x.com/someuser/status/${X_ID}`).map(i => [i.label, i.filename]), [
    ['HD · with sound', `x-${X_ID}-hd.mp4`],
    ['SD · with sound', `x-${X_ID}-sd.mp4`],
  ]);
});

test('pageVideoItems says so when the original X video has no sound (its HLS master has no audio rendition)', () => {
  const silent = new Set(['https://video.twimg.com/ext_tw_video/1/pu/pl/x.m3u8']);
  assert.deepEqual(pageVideoItems([X_TWEET], `https://x.com/someuser/status/${X_ID}`, silent).map(i => i.label), [
    'HD · original has no sound',
    'SD · original has no sound',
  ]);
  assert.ok(pageVideoItems([X_TWEET], `https://x.com/someuser/status/${X_ID}`).every(i => !('hls' in i)));
});

// X's own GraphQL (TweetResultByRestId / TweetDetail, verified 2026-09-28 on a protected account): tweets are
// {"__typename":"Tweet","rest_id","legacy":{…}}; the same media appears in entities.media and extended_entities.media.
const XG_ID = '1300000000000000001';
const XG_MEDIA = {
  id_str: '1300000000000000099', media_key: '7_1300000000000000099', type: 'video',
  media_url_https: 'https://pbs.twimg.com/ext_tw_video_thumb/g/pu/img/t.jpg',
  video_info: { variants: [
    { content_type: 'application/x-mpegURL', url: 'https://video.twimg.com/ext_tw_video/g/pu/pl/g.m3u8' },
    mp4(256000, '360x270', 'g1'), mp4(832000, '480x360', 'g2'), mp4(2176000, '960x720', 'g3'),
  ] },
};
const X_GRAPHQL = JSON.stringify({ data: { tweetResult: { result: {
  __typename: 'Tweet', rest_id: XG_ID,
  legacy: { id_str: XG_ID, entities: { media: [XG_MEDIA] }, extended_entities: { media: [XG_MEDIA] } },
  quoted_status_result: { result: { __typename: 'TweetWithVisibilityResults', tweet: {
    __typename: 'Tweet', rest_id: '1300000000000000002', legacy: { id_str: '1300000000000000002', full_text: 'no media' },
  } } },
} } } });

test('pageVideos reads X GraphQL responses: rest_id is the tweet, repeated media counted once', () => {
  assert.deepEqual(pageVideos([X_GRAPHQL]), [{
    site: 'x', id: XG_ID,
    hd: 'https://video.twimg.com/ext_tw_video/1/pu/vid/avc1/960x720/g3.mp4?tag=12',
    sd: 'https://video.twimg.com/ext_tw_video/1/pu/vid/avc1/480x360/g2.mp4?tag=12',
    thumb: 'https://pbs.twimg.com/ext_tw_video_thumb/g/pu/img/t.jpg',
    hls: 'https://video.twimg.com/ext_tw_video/g/pu/pl/g.m3u8',
  }]);
  assert.deepEqual(pageVideoItems([X_GRAPHQL], `https://x.com/protecteduser/status/${XG_ID}`).map(i => i.label), [
    'HD · with sound',
    'SD · with sound',
  ]);
});

test('syndicationUrl builds the tweet-result request (token as X computes it) for X tweets only', () => {
  assert.equal(syndicationUrl(`https://x.com/someuser/status/${X_ID}`),
    `https://cdn.syndication.twimg.com/tweet-result?id=${X_ID}&token=4uj6o5owj98&lang=en`);
  assert.equal(syndicationUrl('https://x.com/home'), null);
  assert.equal(syndicationUrl('https://www.facebook.com/reel/1000000000000001'), null);
});

test('videoIdFromUrl finds Facebook video ids and Instagram post codes only', () => {
  assert.equal(videoIdFromUrl('https://www.facebook.com/reel/1000000000000001'), '1000000000000001');
  assert.equal(videoIdFromUrl('https://www.facebook.com/reel/1000000000000001/?s=ifu'), '1000000000000001');
  assert.equal(videoIdFromUrl('https://www.facebook.com/watch/?v=123456'), '123456');
  assert.equal(videoIdFromUrl('https://www.facebook.com/SomePage/videos/987654321/'), '987654321');
  assert.equal(videoIdFromUrl('https://m.facebook.com/reel/42'), '42');
  assert.equal(videoIdFromUrl('https://www.facebook.com/'), null);
  assert.equal(videoIdFromUrl('https://www.instagram.com/p/AbCdEfGhIjK/'), 'AbCdEfGhIjK');
  assert.equal(videoIdFromUrl('https://www.instagram.com/reel/AbCdEfGhIjK/?igsh=abc'), 'AbCdEfGhIjK');
  assert.equal(videoIdFromUrl('https://www.instagram.com/reels/C_x-9/'), 'C_x-9');
  assert.equal(videoIdFromUrl('https://www.instagram.com/tv/B1/'), 'B1');
  assert.equal(videoIdFromUrl('https://www.instagram.com/'), null);
  assert.equal(videoIdFromUrl('https://www.instagram.com/stories/someone/3000000000000000105/'), '3000000000000000105');
  assert.equal(videoIdFromUrl('https://www.instagram.com/stories/someone/'), null);
  assert.equal(videoIdFromUrl('https://www.instagram.com/stories/highlights/17912345678901234/'), 'highlight:17912345678901234');
  assert.equal(videoIdFromUrl(`https://www.tiktok.com/@somecreator/video/${TT_ID}?is_from_webapp=1`), TT_ID);
  assert.equal(videoIdFromUrl('https://www.tiktok.com/@somecreator/photo/7661611868921859999'), null);
  assert.equal(videoIdFromUrl('https://www.tiktok.com/foryou'), null);
  assert.equal(videoIdFromUrl(`https://x.com/someuser/status/${X_ID}`), X_ID);
  assert.equal(videoIdFromUrl('https://twitter.com/i/status/123'), '123');
  assert.equal(videoIdFromUrl('https://x.com/a/status/123/video/1'), '123');
  assert.equal(videoIdFromUrl('https://mobile.twitter.com/a/status/456'), '456');
  assert.equal(videoIdFromUrl('https://x.com/home'), null);
  assert.equal(videoIdFromUrl('https://www.youtube.com/watch?v=kJiHgFeDcBa'), null);
  assert.equal(videoIdFromUrl('https://example.com/reel/1000000000000001'), null);
  assert.equal(videoIdFromUrl(undefined), null);
});

test('pageVideoItems: only the video in the URL (never preloaded next ones), HD first, named by site and id; http(s) only', () => {
  assert.deepEqual(pageVideoItems([FB], 'https://www.facebook.com/reel/1000000000000001'), [
    { url: HD1, kind: 'video', size: null, label: 'HD · with sound', filename: 'facebook-1000000000000001-hd.mp4' },
    { url: SD1, kind: 'video', size: null, label: 'SD · with sound', filename: 'facebook-1000000000000001-sd.mp4' },
  ]);
  assert.deepEqual(pageVideoItems([FB], 'https://www.facebook.com/').map(i => i.filename), [
    'facebook-1000000000000001-hd.mp4',
    'facebook-1000000000000001-sd.mp4',
    'facebook-1000000000000002-sd.mp4',
  ]);
  assert.deepEqual(pageVideoItems([FB], 'https://www.facebook.com/reel/999'), []);
  assert.deepEqual(pageVideoItems([IG], 'https://www.instagram.com/p/CAROUSEL1/').map(i => [i.label, i.filename]), [
    ['HD · with sound', 'instagram-CAROUSEL1-hd.mp4'],
    ['SD · with sound', 'instagram-CAROUSEL1-sd.mp4'],
  ]);
});

test('hideSitePieces drops fbcdn/cdninstagram video/audio pieces on Facebook and Instagram pages only', () => {
  const items = [
    { url: 'https://video.fbkk22-4.fna.fbcdn.net/o1/v/t2/f2/m69/AQM.mp4?efg=x', kind: 'video' },
    { url: 'https://video.fbkk22-4.fna.fbcdn.net/o1/v/t2/f2/m69/AQN.mp4?efg=y', kind: 'audio' },
    { url: 'https://scontent-bkk1-1.cdninstagram.com/o1/v/AQO.mp4', kind: 'video' },
    { url: 'https://scontent.fbkk22-4.fna.fbcdn.net/v/photo.jpg', kind: 'image' },
    { url: 'https://cdn.example/clip.mp4', kind: 'video' },
  ];
  const kept = ['https://scontent.fbkk22-4.fna.fbcdn.net/v/photo.jpg', 'https://cdn.example/clip.mp4'];
  assert.deepEqual(hideSitePieces(items, 'https://www.facebook.com/reel/1').map(i => i.url), kept);
  assert.deepEqual(hideSitePieces(items, 'https://www.instagram.com/p/AbCdEfGhIjK/').map(i => i.url), kept);
  assert.equal(hideSitePieces(items, 'https://example.com/').length, 5);
  assert.equal(hideSitePieces(items, undefined).length, 5);
});

test('hideSitePieces drops X\'s HLS playlist and pieces (audio is separate) on X pages, keeps images', () => {
  const items = [
    { url: 'https://video.twimg.com/ext_tw_video/1/pu/pl/x.m3u8', kind: 'hls' },
    { url: 'https://video.twimg.com/ext_tw_video/1/pu/vid/avc1/0/3000/720x936/s.m4s', kind: 'video' },
    { url: 'https://pbs.twimg.com/media/photo.jpg', kind: 'image' },
  ];
  assert.deepEqual(hideSitePieces(items, `https://x.com/someuser/status/${X_ID}`).map(i => i.url), ['https://pbs.twimg.com/media/photo.jpg']);
  assert.equal(hideSitePieces(items, 'https://example.com/').length, 3);
});

test('hideSitePieces drops the TikTok player\'s chunked video files on TikTok pages, keeps images', () => {
  const items = [
    { url: 'https://v16-webapp-prime.tiktok.com/video/tos/alisg/abc/?mime_type=video_mp4', kind: 'video' },
    { url: 'https://v77.tiktokcdn.com/xyz/video.mp4', kind: 'video' },
    { url: 'https://p16-sign-sg.tiktokcdn.com/obj/cover.jpeg', kind: 'image' },
    { url: 'https://cdn.example/clip.mp4', kind: 'video' },
  ];
  assert.deepEqual(hideSitePieces(items, `https://www.tiktok.com/@somecreator/video/${TT_ID}`).map(i => i.url), [
    'https://p16-sign-sg.tiktokcdn.com/obj/cover.jpeg',
    'https://cdn.example/clip.mp4',
  ]);
});
