# Norn Downloader Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Manifest V3 Chrome extension that lists images, videos and HLS streams found on any page, downloads the ones the user ticks (HLS joined into one file, live HLS captured until stopped), and can record the current tab as a fallback.

**Architecture:** `background.js` sniffs responses with `webRequest` into `storage.session`; `popup.js` merges that with a one-shot page scan and starts downloads; `offscreen.js` runs long jobs (HLS joining, live capture, `MediaRecorder`) and hands blob URLs back to background to save. All parsing/classification logic lives in two pure modules (`media.js`, `hls.js`) that Node tests import directly.

**Tech Stack:** Plain JavaScript ES modules, Chrome MV3 APIs (`webRequest`, `downloads`, `scripting`, `offscreen`, `tabCapture`, `storage.session`), Node 24 `node --test`. No dependencies, no build step.

**Spec:** `docs/superpowers/specs/2026-09-28-norn-downloader-design.md`

## Global Constraints

- Manifest V3, `"minimum_chrome_version": "116"`.
- No runtime dependencies, no bundler, no build step. Every `.js` file is an ES module.
- `media.js` and `hls.js` must never reference `chrome`, `document` or `window`.
- Page-derived strings go into the DOM only through `textContent` / element properties — never `innerHTML`.
- Only `http:`/`https:` URLs are listed or downloaded.
- No DRM or encrypted-HLS circumvention: encrypted (`EXT-X-KEY` METHOD ≠ `NONE`) and byte-range playlists are refused with "… — use Record tab instead".
- Deliberate shortcuts carry a `// ponytail:` comment naming the ceiling and the upgrade path.
- Code comments in English; README in Thai.
- Commit after every task; commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

- Infinite feeds (IG/FB scroll) re-request the same media and load thousands of files → one entry per URL, only the newest 500 kept (Task 1, `addItem` tests).
- IG/FB serve one video as many `bytestart=…&byteend=…` pieces → one entry per video, the signed query params byte-identical (Task 1, `cleanUrl` tests).
- A segment 403s halfway through an HLS download → no new fetches start, no progress reported after the failure, the job rejects (Task 2, `fetchInOrder` failure test).
- Pages expose `blob:`, `data:`, `javascript:` or malformed URLs → never listed (Task 4, `mergeItems` test).
- Tab titles with `: / ? " < > | *`, leading dots, emoji or nothing at all → still a valid Windows filename (Task 4, `safeName` test).

---

## File Structure

```
manifest.json          MV3 manifest (Task 3, popup added in Task 4)
package.json           {"type":"module"} for Node tests only (Task 1)
media.js               classify, cleanUrl, addItem, MAX_ITEMS (Task 1); safeName, srcsetBest, mergeItems (Task 4)
hls.js                 parse, pickBest, fetchInOrder (Task 2)
background.js          sniffer (Task 3); offscreen routing, badge, save, errors (Task 5)
popup.html, popup.js   UI + page scan (Task 4)
offscreen.html         loads offscreen.js (Task 5)
offscreen.js           HLS VOD + live (Task 5); tab recording (Task 6)
test/media.test.js     (Task 1, extended in Task 4)
test/hls.test.js       (Task 2)
README.md              install + manual checklist (Task 6)
```

---

### Task 1: Media classification helpers

**Files:**
- Create: `package.json`
- Create: `media.js`
- Test: `test/media.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces (all exported from `media.js`):
  - `classify(url: string, mime?: string): 'image'|'video'|'audio'|'hls'|null`
  - `cleanUrl(url: string): string`
  - `MAX_ITEMS: number` (500)
  - `addItem(items: Item[], item: Item): Item[]` — returns the **same array object** when `item.url` is already present; otherwise a new array with the item appended, trimmed to the newest `MAX_ITEMS`. `Item = { url, kind, mime, size }`.

- [ ] **Step 1: Create `package.json`**

```json
{
  "private": true,
  "type": "module",
  "scripts": { "test": "node --test" }
}
```

- [ ] **Step 2: Write the failing tests** — create `test/media.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { classify, cleanUrl, addItem, MAX_ITEMS } from '../media.js';

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
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `node --test test/media.test.js`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` (cannot find `media.js`).

- [ ] **Step 4: Implement `media.js`**

```js
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
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test test/media.test.js`
Expected: PASS, 6 tests, 0 failures.

- [ ] **Step 6: Commit**

```bash
git add package.json media.js test/media.test.js
git commit -m "feat: media classification, byte-range URL cleanup, capped item list

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: HLS parser and ordered download pool

**Files:**
- Create: `hls.js`
- Test: `test/hls.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces (exported from `hls.js`):
  - `parse(text: string, baseUrl: string): Playlist` — throws `Error('Not an HLS playlist')` if the first non-empty line isn't `#EXTM3U`.
    `Playlist = { master: boolean, variants: {url, bandwidth}[], segments: {url, seq}[], map: string|null, targetDuration: number, ended: boolean, unsupported: null|'Encrypted stream'|'Byte-range playlist' }`. All URLs absolute.
  - `pickBest(variants): {url, bandwidth}` — highest bandwidth; `variants` must be non-empty.
  - `fetchInOrder(urls: string[], get: (url) => Promise<T>, onEach?: (done: number, total: number) => void, limit = 6): Promise<T[]>` — results in input order; after the first rejection no new `get` starts, `onEach` is not called again, and the promise rejects with that error.

- [ ] **Step 1: Write the failing tests** — create `test/hls.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { parse, pickBest, fetchInOrder } from '../hls.js';

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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/hls.test.js`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` (cannot find `hls.js`).

- [ ] **Step 3: Implement `hls.js`**

```js
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test`
Expected: PASS, 16 tests (6 media + 10 hls), 0 failures.

- [ ] **Step 5: Commit**

```bash
git add hls.js test/hls.test.js
git commit -m "feat: m3u8 parser and ordered download pool

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Manifest and network sniffer

**Files:**
- Create: `manifest.json`
- Create: `background.js`

**Interfaces:**
- Consumes: `classify`, `cleanUrl`, `addItem` from `media.js` (Task 1).
- Produces:
  - `storage.session` key `tab:<tabId>` → `Item[]` (oldest first, max 500), cleared on the tab's `main_frame` response and on tab close.
  - In `background.js` (module scope, used by Task 5): `const store = chrome.storage.session`, `serial(fn)` — runs `fn` after every previously queued `fn`; all storage read-modify-writes must go through it.

- [ ] **Step 1: Create `manifest.json`** (popup is added in Task 4)

```json
{
  "manifest_version": 3,
  "name": "Norn Downloader",
  "version": "0.1.0",
  "description": "Pick and download images, videos and HLS streams from any page, or record the tab.",
  "minimum_chrome_version": "116",
  "permissions": ["webRequest", "downloads", "scripting", "activeTab", "offscreen", "tabCapture", "storage"],
  "host_permissions": ["<all_urls>"],
  "background": { "service_worker": "background.js", "type": "module" },
  "action": { "default_title": "Norn Downloader" }
}
```

- [ ] **Step 2: Create `background.js`**

```js
import { classify, cleanUrl, addItem } from './media.js';

const store = chrome.storage.session;
const tabKey = tabId => `tab:${tabId}`;

// ponytail: one global queue serialises every storage read-modify-write; per-key queues if it ever lags
let queue = Promise.resolve();
const serial = fn => (queue = queue.then(fn).catch(e => console.error(e)));

chrome.webRequest.onResponseStarted.addListener(
  d => {
    if (d.tabId < 0 || d.statusCode >= 400) return;
    if (d.type === 'main_frame') return serial(() => store.remove(tabKey(d.tabId)));
    const header = name => d.responseHeaders?.find(h => h.name.toLowerCase() === name)?.value ?? '';
    const mime = header('content-type');
    const kind = classify(d.url, mime);
    // 206 responses: Content-Range holds the full size, Content-Length only this piece
    const size = Number(header('content-range').split('/')[1]) || Number(header('content-length')) || null;
    if (!kind || (kind === 'image' && size && size < 2048)) return; // ponytail: <2 KB images are icons/pixels
    const item = { url: cleanUrl(d.url), kind, mime, size };
    serial(async () => {
      const key = tabKey(d.tabId);
      const { [key]: items = [] } = await store.get(key);
      const next = addItem(items, item);
      if (next !== items) await store.set({ [key]: next });
    });
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders'],
);

chrome.tabs.onRemoved.addListener(tabId => serial(() => store.remove(tabKey(tabId))));
```

- [ ] **Step 3: Syntax check**

Run: `node --check background.js`
Expected: no output, exit code 0.

- [ ] **Step 4: Manual check in Chrome**

1. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, pick the project folder. Expected: the extension loads with no error card.
2. Open `<page with many images>` in a tab.
3. On the extension card click **service worker** (Inspect views) and run in its console: `await chrome.storage.session.get()`
   Expected: a `tab:<number>` key holding objects with `kind: "image"`, `https://upload.wikimedia.org/...` URLs, numeric `size`, no `.svg` icons under 2 KB.
4. Reload the Wikimedia tab and run the same command. Expected: the list was cleared and rebuilt (no duplicate URLs).
5. Close the tab, run it again. Expected: that `tab:<number>` key is gone.

- [ ] **Step 5: Commit**

```bash
git add manifest.json background.js
git commit -m "feat: sniff media responses per tab into storage.session

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Popup — page scan, list, direct downloads

**Files:**
- Modify: `media.js` (append `safeName`, `srcsetBest`, `mergeItems`)
- Modify: `test/media.test.js` (import line + new tests)
- Modify: `manifest.json` (`action.default_popup`)
- Create: `popup.html`
- Create: `popup.js`

**Interfaces:**
- Consumes: `classify`, `cleanUrl` (Task 1); `storage.session` keys `tab:<id>` (Task 3), `status`, `lastError` (written in Task 5; absent until then).
- Produces:
  - `safeName(title: string|undefined): string`
  - `srcsetBest(srcset: string): string|null`
  - `mergeItems(net: Item[], scan: {found: {url, kind}[], srcsets: string[], base: string}): {url, kind, size}[]`
  - Messages sent from the popup to background (handled in Task 5/6): `{type:'hls', url, name}`, `{type:'record', streamId, name}`, `{type:'stop', what:'record'|'live'}`, `{type:'clearError'}`.

- [ ] **Step 1: Write the failing tests**

In `test/media.test.js` replace the import line with:

```js
import { classify, cleanUrl, addItem, MAX_ITEMS, safeName, srcsetBest, mergeItems } from '../media.js';
```

Append to `test/media.test.js`:

```js
test('safeName makes tab titles safe for Windows filenames', () => {
  assert.equal(safeName('Reel: cats / dogs? "live" <1> | 2*'), 'Reel_ cats _ dogs_ _live_ _1_ _ 2_');
  assert.equal(safeName('  ..hidden..  '), 'hidden');
  assert.equal(safeName('วิดีโอ 🎬'), 'วิดีโอ 🎬');
  assert.equal(safeName(''), 'norn');
  assert.equal(safeName(undefined), 'norn');
  assert.equal(safeName('x'.repeat(300)).length, 100);
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/media.test.js`
Expected: FAIL — `SyntaxError: The requested module '../media.js' does not provide an export named …` (one of `safeName`, `srcsetBest`, `mergeItems`).

- [ ] **Step 3: Append the implementation to `media.js`**

```js
// Tab title → filename Windows and Chrome accept. Counts code points so emoji aren't cut in half.
export function safeName(title) {
  const name = Array.from(String(title ?? '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_'))
    .slice(0, 100)
    .join('')
    .replace(/^[. ]+|[. ]+$/g, '');
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test`
Expected: PASS, 19 tests, 0 failures.

- [ ] **Step 5: Add the popup to `manifest.json`** — replace the `action` line with:

```json
  "action": { "default_title": "Norn Downloader", "default_popup": "popup.html" }
```

- [ ] **Step 6: Create `popup.html`**

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Norn Downloader</title>
<style>
  :root { color-scheme: light dark; --bg: #fff; --fg: #1a1a1a; --muted: #6b6b6b; --line: #e3e3e3; --accent: #3b5bdb; --danger: #c92a2a; }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #1e1e1e; --fg: #eee; --muted: #9a9a9a; --line: #333; --accent: #748ffc; --danger: #ff6b6b; }
  }
  [hidden] { display: none !important; }
  body { margin: 0; width: 380px; font: 13px system-ui, sans-serif; background: var(--bg); color: var(--fg); }
  .bar { display: flex; gap: 6px; align-items: center; padding: 8px 10px; border-bottom: 1px solid var(--line); }
  .spacer { flex: 1; }
  button { font: inherit; padding: 4px 10px; border: 1px solid var(--line); border-radius: 6px; background: none; color: inherit; cursor: pointer; }
  button[aria-pressed="true"], button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  button:disabled { opacity: .5; cursor: default; }
  .note { margin: 8px 10px 0; padding: 6px 8px; border: 1px solid var(--line); border-radius: 6px; }
  .note.error { display: flex; gap: 6px; align-items: start; border-color: var(--danger); color: var(--danger); white-space: pre-line; }
  #grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; padding: 10px; max-height: 420px; overflow-y: auto; }
  .card { position: relative; display: flex; flex-direction: column; gap: 2px; cursor: pointer; min-width: 0; }
  .card input { position: absolute; top: 4px; left: 4px; margin: 0; }
  .thumb { width: 100%; aspect-ratio: 1; object-fit: cover; border-radius: 6px; background: var(--line); display: grid; place-items: center; font-weight: 600; color: var(--muted); }
  .card:has(input:checked) .thumb { outline: 2px solid var(--accent); outline-offset: -2px; }
  .card small { color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .empty { grid-column: 1 / -1; margin: 0; padding: 24px 0; text-align: center; color: var(--muted); }
</style>
</head>
<body>
  <div class="bar">
    <button data-filter="all" data-label="All" aria-pressed="true">All</button>
    <button data-filter="image" data-label="Images">Images</button>
    <button data-filter="video" data-label="Videos">Videos</button>
    <button data-filter="hls" data-label="Streams">Streams</button>
  </div>
  <div class="bar">
    <label><input type="checkbox" id="all"> Select all</label>
    <span class="spacer"></span>
    <button id="download" class="primary" disabled>Download</button>
  </div>
  <div class="bar">
    <button id="record">Record tab</button>
    <button id="stopLive" hidden>Stop live</button>
  </div>
  <div id="error" class="note error" hidden>
    <span id="errorText" class="spacer"></span>
    <button id="dismiss" aria-label="Dismiss">×</button>
  </div>
  <div id="hint" class="note" hidden>This page plays video through a stream player (blob:). If it isn't listed, use Record tab.</div>
  <div id="grid"></div>
  <script type="module" src="popup.js"></script>
</body>
</html>
```

- [ ] **Step 7: Create `popup.js`**

```js
import { mergeItems, safeName } from './media.js';

const $ = sel => document.querySelector(sel);

// Runs inside the page (must stay self-contained): media the sniffer may not have seen,
// e.g. lazy images and the larger srcset sizes that were never requested.
function scanPage() {
  const found = [];
  const srcsets = [];
  const kindOf = el =>
    ({ VIDEO: 'video', AUDIO: 'audio' })[(el.tagName === 'SOURCE' ? el.parentElement : el)?.tagName] ?? 'image';
  for (const el of document.querySelectorAll('img, video, audio, source')) {
    const src = el.currentSrc || el.src;
    if (src) found.push({ url: src, kind: kindOf(el) });
    if (el.poster) found.push({ url: el.poster, kind: 'image' });
    const srcset = el.getAttribute('srcset');
    if (srcset) srcsets.push(srcset);
  }
  for (const m of document.querySelectorAll('meta[property]')) {
    const kind = m.getAttribute('property').match(/^og:(image|video)(:url|:secure_url)?$/)?.[1];
    if (kind && m.content) found.push({ url: m.content, kind });
  }
  for (const el of document.querySelectorAll('*')) {
    for (const [, url] of getComputedStyle(el).backgroundImage.matchAll(/url\("?(.*?)"?\)/g)) {
      found.push({ url, kind: 'image' });
    }
  }
  const blobVideo = [...document.querySelectorAll('video')].some(v => (v.currentSrc || v.src).startsWith('blob:'));
  return { found, srcsets, base: document.baseURI, blobVideo };
}

const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
const key = `tab:${tab.id}`;
const { [key]: net = [], status = {}, lastError } = await chrome.storage.session.get([key, 'status', 'lastError']);
const name = safeName(tab.title);

let scan = { found: [], srcsets: [], base: tab.url, blobVideo: false };
try {
  scan = (await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: scanPage }))[0].result ?? scan;
} catch {
  // chrome:// pages, the Web Store, PDFs: network list only
}

const items = mergeItems(net, scan);
const selected = new Set();
let filter = 'all';

const matches = (item, f) => f === 'all' || item.kind === f || (f === 'video' && item.kind === 'audio');
const visible = () => items.filter(i => matches(i, filter));

function fileName(url) {
  const u = new URL(url);
  try {
    return decodeURIComponent(u.pathname.split('/').pop()) || u.hostname;
  } catch {
    return u.hostname;
  }
}

const fmtSize = b => (b == null ? '' : b < 1024 ** 2 ? `${Math.round(b / 1024)} KB` : `${(b / 1024 ** 2).toFixed(1)} MB`);

function card(item) {
  const label = document.createElement('label');
  label.className = 'card';
  label.title = item.url;
  const box = Object.assign(document.createElement('input'), { type: 'checkbox', checked: selected.has(item.url) });
  box.onchange = () => {
    if (box.checked) selected.add(item.url);
    else selected.delete(item.url);
    sync();
  };
  const thumb =
    item.kind === 'image'
      ? Object.assign(document.createElement('img'), { src: item.url, loading: 'lazy', alt: '' })
      : Object.assign(document.createElement('div'), { textContent: item.kind.toUpperCase() });
  thumb.classList.add('thumb');
  const meta = document.createElement('small');
  meta.textContent = [fileName(item.url), fmtSize(item.size)].filter(Boolean).join(' · ');
  label.append(box, thumb, meta);
  return label;
}

function sync() {
  const list = visible();
  $('#all').checked = list.length > 0 && list.every(i => selected.has(i.url));
  $('#download').disabled = selected.size === 0;
  $('#download').textContent = selected.size ? `Download ${selected.size}` : 'Download';
}

function render() {
  for (const b of document.querySelectorAll('[data-filter]')) {
    const f = b.dataset.filter;
    b.setAttribute('aria-pressed', String(f === filter));
    b.textContent = `${b.dataset.label} ${items.filter(i => matches(i, f)).length}`;
  }
  const list = visible();
  const empty = Object.assign(document.createElement('p'), {
    className: 'empty',
    textContent: 'Nothing found yet. Play or scroll the page, then reopen.',
  });
  $('#grid').replaceChildren(...(list.length ? list.map(card) : [empty]));
  sync();
}

function showError(text) {
  $('#errorText').textContent = text;
  $('#error').hidden = false;
}

for (const b of document.querySelectorAll('[data-filter]')) {
  b.onclick = () => {
    filter = b.dataset.filter;
    render();
  };
}

$('#all').onchange = e => {
  for (const i of visible()) {
    if (e.target.checked) selected.add(i.url);
    else selected.delete(i.url);
  }
  render();
};

$('#download').onclick = async () => {
  const errors = [];
  for (const item of items.filter(i => selected.has(i.url))) {
    try {
      if (item.kind === 'hls') await chrome.runtime.sendMessage({ type: 'hls', url: item.url, name });
      else await chrome.downloads.download({ url: item.url, saveAs: false });
    } catch (e) {
      errors.push(`${fileName(item.url)}: ${e.message}`);
    }
  }
  if (errors.length) showError(errors.join('\n'));
  else window.close();
};

$('#record').textContent = status.recording ? 'Stop recording' : 'Record tab';
$('#record').onclick = async () => {
  try {
    if (status.recording) {
      await chrome.runtime.sendMessage({ type: 'stop', what: 'record' });
    } else {
      // Called here, inside the click, so the activeTab grant from opening the popup applies.
      const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
      await chrome.runtime.sendMessage({ type: 'record', streamId, name });
    }
    window.close();
  } catch (e) {
    showError(e.message);
  }
};

$('#stopLive').hidden = !status.live;
$('#stopLive').onclick = async () => {
  await chrome.runtime.sendMessage({ type: 'stop', what: 'live' });
  window.close();
};

$('#dismiss').onclick = () => {
  $('#error').hidden = true;
  chrome.runtime.sendMessage({ type: 'clearError' });
};

if (lastError) showError(lastError);
$('#hint').hidden = !scan.blobVideo;
render();
```

- [ ] **Step 8: Syntax check**

Run: `node --check popup.js && node --check media.js`
Expected: no output, exit code 0.

- [ ] **Step 9: Manual check in Chrome**

1. `chrome://extensions` → Norn Downloader → reload (↻).
2. Open `<page with many images>`, click the extension icon.
   Expected: filter buttons show counts (e.g. `Images 25`), grid of image thumbnails with filename · size.
3. Click **Images**, tick two cards. Expected: button reads `Download 2`; ticked cards get an accent outline.
4. Click **Download 2**. Expected: popup closes, two files appear in `chrome://downloads`, no Save As dialog.
5. Open `<direct mp4 URL>` (Chrome's built-in player), open the popup.
   Expected: under **Videos** the mp4 is listed; downloading it saves the mp4.
6. Open the popup on `chrome://extensions`. Expected: "Nothing found yet…" and no error.
7. Back on Wikimedia: switch to **Images**, tick **Select all**, then switch to **All**.
   Expected: on **All** the Select all box is unticked (only the image items are selected) and the button reads `Download <number of images>`.

- [ ] **Step 10: Commit**

```bash
git add media.js test/media.test.js manifest.json popup.html popup.js
git commit -m "feat: popup with page scan, filters and direct downloads

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: HLS download and live capture (offscreen + background routing)

**Files:**
- Modify: `background.js` (append routing, badge, save, errors)
- Create: `offscreen.html`
- Create: `offscreen.js`

**Interfaces:**
- Consumes: `parse`, `pickBest`, `fetchInOrder` (Task 2); `store`, `serial` in `background.js` (Task 3); popup messages `hls`, `stop`, `clearError` (Task 4).
- Produces:
  - `storage.session` keys `status` = `{ recording: boolean, live: boolean }` and `lastError` = `string|null`.
  - Offscreen message handlers table `jobs` in `offscreen.js` (Task 6 adds `record` and the `record` branch of `stop`).
  - Offscreen → background messages: `{type:'progress', text}`, `{type:'status', patch}`, `{type:'save', url, filename}`, `{type:'error', message}`.
  - Background → offscreen: `{target:'offscreen', type:'hls'|'record'|'stop'|'revoke', ...}`.
  - Offscreen helpers used by Task 6: `send(msg)`, `save(parts: BlobPart[], name, ext): Promise`.

- [ ] **Step 1: Append to `background.js`**

```js
// ---- Offscreen jobs, badge, saving ----

const OFFSCREEN_JOBS = ['hls', 'record', 'stop'];

const hasOffscreen = async () =>
  (await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })).length > 0;

// ponytail: the offscreen document stays open once created; close it when idle if memory matters
let creating = null;
async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  creating ??= chrome.offscreen
    .createDocument({
      url: 'offscreen.html',
      reasons: ['BLOBS', 'USER_MEDIA'],
      justification: 'Join HLS segments into one file and record tabs',
    })
    .finally(() => (creating = null));
  await creating;
}

async function idleBadge() {
  const { status = {} } = await store.get('status');
  await chrome.action.setBadgeText({ text: status.recording ? 'REC' : status.live ? 'LIVE' : '' });
}

const setStatus = patch =>
  serial(async () => {
    const { status = {} } = await store.get('status');
    await store.set({ status: { ...status, ...patch } });
    await idleBadge();
  });

async function fail(message) {
  await store.set({ lastError: message });
  await chrome.action.setBadgeText({ text: '!' });
}

async function toOffscreen(msg) {
  if (msg.type === 'stop' && !(await hasOffscreen())) return setStatus({ recording: false, live: false });
  await ensureOffscreen();
  await chrome.runtime.sendMessage({ ...msg, target: 'offscreen' });
}

// downloadId -> blob URL owned by offscreen; revoked once the file is written.
// ponytail: lost if the worker restarts mid-download, the blob then lives until the offscreen doc closes
const blobs = new Map();

const handlers = {
  progress: m => chrome.action.setBadgeText({ text: m.text }),
  status: m => setStatus(m.patch),
  error: m => fail(m.message),
  async save(m) {
    try {
      blobs.set(await chrome.downloads.download({ url: m.url, filename: m.filename, saveAs: false }), m.url);
    } catch (e) {
      return fail(`Save failed: ${e.message}`);
    }
    await idleBadge();
  },
  async clearError() {
    await store.set({ lastError: null });
    await idleBadge();
  },
};

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  reply(); // ack so the sender's promise resolves; results travel as separate messages
  if (OFFSCREEN_JOBS.includes(msg.type)) toOffscreen(msg).catch(e => fail(e.message));
  else handlers[msg.type]?.(msg);
});

chrome.downloads.onChanged.addListener(({ id, state }) => {
  if (!blobs.has(id) || !state || state.current === 'in_progress') return;
  // offscreen may already be gone, then so is the blob
  chrome.runtime.sendMessage({ target: 'offscreen', type: 'revoke', url: blobs.get(id) }).catch(() => {});
  blobs.delete(id);
});
```

- [ ] **Step 2: Create `offscreen.html`**

```html
<!doctype html>
<script type="module" src="offscreen.js"></script>
```

- [ ] **Step 3: Create `offscreen.js`**

```js
import { parse, pickBest, fetchInOrder } from './hls.js';

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
  let last = -1;
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
    if (last >= 0) await save(parts, name, ext); // keep what was captured even if the loop failed
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
```

- [ ] **Step 4: Syntax check and unit tests**

Run: `node --check background.js && node --check offscreen.js && node --test`
Expected: no syntax errors; 19 tests pass.

- [ ] **Step 5: Manual check in Chrome**

1. Reload the extension.
2. **HLS VOD (TS):** open `<HLS player page> stream URL, encoded>`, let it play 3 s, open the popup → **Streams**.
   Expected: `x36xhzz.m3u8` (and its variant playlists) listed as `HLS`. Tick `x36xhzz.m3u8` → Download. Badge counts `1%`…`100%`, then clears; a `.ts` file lands in Downloads and plays in VLC / Windows Media Player with sound, full length (~10 min).
3. **HLS fMP4:** same demo page with `src=<test stream URL, encoded>`, download `master.m3u8`.
   Expected: a `.mp4` that plays (video-only is expected: this stream keeps audio in a separate rendition).
4. **Live:** demo page with `src=<test stream URL, encoded>`, download `master.m3u8`.
   Expected: badge `LIVE`. After ~30 s reopen the popup: **Stop live** is visible. Click it. Within one segment duration the badge clears and a `.ts` of roughly 30 s is saved.
5. **Error path:** on `chrome://extensions` click **offscreen.html** under Inspect views and run `chrome.runtime.sendMessage({ type: 'error', message: 'test error' })`.
   Expected: badge `!`; opening the popup shows the red banner "test error"; × hides it and clears the badge; reopening the popup shows no banner.

- [ ] **Step 6: Commit**

```bash
git add background.js offscreen.html offscreen.js
git commit -m "feat: HLS VOD join and live capture in offscreen document

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Tab recording + README

**Files:**
- Modify: `offscreen.js` (add `record`, extend `stop` and `jobs`)
- Create: `README.md`

**Interfaces:**
- Consumes: `send`, `save`, `jobs`, `stop` in `offscreen.js` (Task 5); popup `record` / `stop {what:'record'}` messages (Task 4); background forwards `record` (Task 5 `OFFSCREEN_JOBS`).
- Produces: `status.recording` updates via `{type:'status', patch:{recording}}`; a saved `.mp4` or `.webm`.

- [ ] **Step 1: Add recording to `offscreen.js`** — insert above `function stop(what)`:

```js
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
  const mimeType = ['video/mp4;codecs=avc1,mp4a.40.2', 'video/webm;codecs=vp9,opus', 'video/webm'].find(t =>
    MediaRecorder.isTypeSupported(t),
  );
  const chunks = [];
  recorder = new MediaRecorder(stream, { mimeType });
  recorder.ondataavailable = e => e.data.size && chunks.push(e.data);
  recorder.onstop = async () => {
    stream.getTracks().forEach(t => t.stop());
    audio.close();
    recorder = null;
    await send({ type: 'status', patch: { recording: false } });
    await save(chunks, name, mimeType.startsWith('video/mp4') ? 'mp4' : 'webm');
  };
  // tab closed or navigated to an uncapturable page → finish and save
  stream.getVideoTracks()[0].onended = () => recorder?.state === 'recording' && recorder.stop();
  recorder.start();
  await send({ type: 'status', patch: { recording: true } });
}
```

Replace `function stop(what)` with:

```js
function stop(what) {
  if (what === 'record') {
    if (recorder?.state === 'recording') recorder.stop();
  } else liveStops.forEach(s => s());
}
```

Replace the `jobs` table with:

```js
const jobs = {
  hls: m => hls(m.url, m.name),
  record: m => record(m.streamId, m.name),
  stop: m => stop(m.what),
  revoke: m => URL.revokeObjectURL(m.url),
};
```

- [ ] **Step 2: Syntax check**

Run: `node --check offscreen.js`
Expected: no output, exit code 0.

- [ ] **Step 3: Create `README.md`**

````markdown
# Norn Downloader

Chrome extension สำหรับเลือกโหลดรูป / วิดีโอ / สตรีม HLS จากทุกเว็บ และอัดแท็บเป็นวิดีโอ

## ติดตั้ง

1. เปิด `chrome://extensions` แล้วเปิด **Developer mode** (มุมขวาบน)
2. กด **Load unpacked** แล้วเลือกโฟลเดอร์นี้
3. ปักหมุดไอคอน Norn Downloader ไว้ที่แถบเครื่องมือ

## ใช้งาน

- เปิดหน้าเว็บ เลื่อนดู/กดเล่นวิดีโอให้โหลดก่อน แล้วกดไอคอน
- เลือกแท็บ **Images / Videos / Streams** ติ๊กรายการที่ต้องการ แล้วกด **Download**
- สตรีม (m3u8): ถ้าเป็นคลิปจบแล้วจะรวมเป็นไฟล์เดียว (.ts หรือ .mp4) ถ้าเป็นไลฟ์จะอัดต่อไปจนกด **Stop live**
- ไม่เจอวิดีโอ (เช่น reel / story ที่เล่นผ่าน blob:) → กด **Record tab** แล้วเล่นวิดีโอ กด **Stop recording** เมื่อจบ
- ไอคอนแสดงสถานะ: `42%` กำลังรวมไฟล์, `LIVE` กำลังอัดไลฟ์, `REC` กำลังอัดแท็บ, `!` มี error (เปิด popup เพื่อดู)

## ข้อจำกัด

- เนื้อหา DRM (Netflix, Disney+ ฯลฯ) และสตรีมที่เข้ารหัส โหลดไม่ได้ อัดแท็บก็จะได้จอดำ
- Reel ของ IG/FB ที่จับได้จาก network มักเป็นวิดีโอไม่มีเสียง (เสียงแยกไฟล์) → ใช้ Record tab
- สตรีมที่แยกเสียงเป็น playlist ต่างหาก จะได้แต่ภาพ
- CDN บางเจ้าเช็ค Referer จะโหลดไม่ได้ (ขึ้น HTTP 403)

## ทดสอบ

```bash
node --test
```

### Checklist ทดสอบใน Chrome

- [ ] หน้า `<page with many images>` → รายการรูปมีขนาดไฟล์ เลือก 2 รูปแล้วโหลดได้ ไม่มี dialog
- [ ] เปิด mp4 ตรงๆ → อยู่ใน Videos โหลดได้
- [ ] HLS VOD (TS): hls.js demo + `<public HLS VOD test stream>` → badge % → ได้ .ts เล่นได้มีเสียง
- [ ] HLS fMP4: Apple `img_bipbop_adv_example_fmp4/master.m3u8` → ได้ .mp4 เล่นได้ (ภาพอย่างเดียว)
- [ ] Live: `<public live HLS test stream>` → badge LIVE → Stop live → ได้ไฟล์ยาวพอๆ กับเวลาที่อัด
- [ ] Record tab บน YouTube → ระหว่างอัดยังได้ยินเสียง → Stop recording → ได้ .mp4/.webm มีภาพและเสียง
- [ ] Record tab แล้วปิดแท็บนั้นกลางทาง → ไฟล์ถูกเซฟเอง badge หาย
- [ ] Error: ใน console ของ offscreen.html รัน `chrome.runtime.sendMessage({ type: 'error', message: 'test error' })` → badge `!` → popup แสดงแถบแดง → กด × แล้วหาย
````

- [ ] **Step 4: Manual check in Chrome**

1. Reload the extension.
2. Open a YouTube video (non-DRM), start playing, open the popup → **Record tab**.
   Expected: popup closes, badge `REC`, the video's sound is still audible.
3. After ~15 s open the popup. Expected: the button reads **Stop recording**. Click it.
   Expected: badge clears, a `.mp4` (or `.webm` on older Chrome) of ~15 s with picture and sound is saved.
4. Start **Record tab** again, then close that tab after ~5 s.
   Expected: a ~5 s file is saved automatically, badge clears; reopening the popup on another tab shows **Record tab**.
5. Start recording, switch to a different tab while `REC` is showing, and open the popup there.
   Expected: the button reads **Stop recording** (only one recording at a time); clicking it saves the first recording.
6. Walk the rest of the README checklist once.

- [ ] **Step 5: Run the whole test suite**

Run: `node --test`
Expected: 19 tests pass, 0 failures.

- [ ] **Step 6: Commit**

```bash
git add offscreen.js README.md
git commit -m "feat: tab recording fallback and README

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
