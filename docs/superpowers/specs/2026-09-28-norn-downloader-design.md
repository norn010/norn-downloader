# Norn Downloader — Design

Date: 2026-09-28
Status: approved in chat, pending spec review

## Goal

Chrome extension (Manifest V3) that lets the user pick and download media from **any site**:
images, videos, HLS streams (VOD and live), plus a tab-recording fallback for everything else
(e.g. reels/stories served as `blob:` MSE video).

Success = open popup on a page → see found media with type/size/thumbnail → tick items →
download; HLS saves as one playable file; live HLS and tab recording can be started and stopped.

## Non-goals

- Site-specific extractors (Instagram/Facebook/TikTok APIs).
- DRM content (Widevine etc.) — not supported, no circumvention.
- Encrypted HLS (`EXT-X-KEY` with `METHOD` other than `NONE`) — refused with a message pointing to tab recording.
- Merging separate audio renditions (`EXT-X-MEDIA TYPE=AUDIO`) — result is video-only; documented limitation.
- DASH (`.mpd`) parsing.
- Setting `Referer` for CDNs that check it — left as a `ponytail:` note (add via `declarativeNetRequest` when needed).

## Stack

Plain JavaScript, no build step, no runtime dependencies. Tests use Node's built-in `node --test`.

## Files

| File | Responsibility |
|------|----------------|
| `manifest.json` | MV3 manifest, permissions |
| `background.js` | Service worker: network sniffing, per-tab media list, downloads, badge, offscreen lifecycle, message routing |
| `popup.html` / `popup.js` | UI: filters, list with checkboxes, download/record buttons, page scan injection |
| `offscreen.html` / `offscreen.js` | Long jobs: HLS VOD download+merge, live HLS capture, tab recording via `MediaRecorder` |
| `hls.js` | Pure m3u8 parser (no DOM/chrome APIs), usable from offscreen and Node tests |
| `test/hls.test.js` | Parser tests |

No persistent content script: the popup injects a one-shot scan function with `chrome.scripting.executeScript`.

## Permissions

`webRequest`, `downloads`, `scripting`, `activeTab`, `offscreen`, `tabCapture`, `storage`; host permission `<all_urls>`.

## Data model

Stored in `chrome.storage.session` under key `tab:<tabId>` (survives service-worker restarts, cleared on browser exit):

```js
{ url, kind: 'image' | 'video' | 'audio' | 'hls', mime, size /* bytes or null */ }
```

Plus `lastError` (string or null) for surfacing failures on next popup open.

## Flow 1 — Detection

1. `background.js` listens to `chrome.webRequest.onResponseStarted` for `<all_urls>`.
2. Classify each response by `Content-Type` header, falling back to URL extension:
   - `image/*` or `.jpg .jpeg .png .gif .webp .avif .svg` → `image`
   - `video/*` (except `video/mp2t`) or `.mp4 .webm .mov .mkv` → `video`
   - `audio/*` or `.mp3 .m4a .aac .ogg .wav .opus` → `audio`
   - `application/vnd.apple.mpegurl`, `application/x-mpegurl`, or `.m3u8` → `hls`
   - Segment noise (`.ts`, `.m4s`, `video/mp2t`) → ignored.
   - Anything else → ignored.
3. `size` from `Content-Length` header when present.
4. Append to `tab:<tabId>` if URL not already present. A `main_frame` request for the tab clears its list first.
5. `tabs.onRemoved` deletes the tab's key.

## Flow 2 — Popup

1. On open: get active tab, read `tab:<tabId>` from background, and inject a scan function that returns URLs from:
   `<img src>` / `currentSrc`, `srcset` (all candidates), `<video src>` / `<source src>` / `poster`,
   `<meta property="og:image|og:video">`, computed `background-image: url(...)`.
2. Merge network + DOM results, dedupe by URL. DOM-only items have `size: null`.
3. `blob:` / `data:` URLs from `<video>` are not listed as downloadable; if any `<video>` has a `blob:` src,
   show a hint: "Video uses a stream player — use Record tab".
4. UI: filter tabs (All / Images / Videos / Streams — audio falls under Videos), grid of cards
   (thumbnail for images, type label for others, size, checkbox), Select all, Download selected,
   Record tab / Stop recording, and the `lastError` banner if set (dismissible, clears it).
5. HLS cards: a live playlist shows "Record live"; a VOD playlist is downloadable like any other item.
   Live/VOD is determined when the popup opens by fetching the playlist and running the parser.

## Flow 3 — Downloads

- Direct files (`image`/`video`/`audio`): `chrome.downloads.download({ url })` — continues after popup closes.
- HLS VOD: popup sends `{ type: 'hls', url }` to background → background ensures offscreen document → offscreen job.
- Offscreen cannot call `chrome.downloads`; it creates a blob URL and sends `{ type: 'save', url, filename }`
  to background, which calls `chrome.downloads.download`. Blob URL revoked after the download completes.

## Flow 4 — HLS VOD (offscreen)

1. Fetch playlist text; `parse(text, baseUrl)`.
2. If master: pick variant with highest `BANDWIDTH`, fetch and parse that media playlist.
3. If any segment key has `METHOD` ≠ `NONE` → fail with "Encrypted stream — use Record tab".
4. Download init segment (`EXT-X-MAP`) if present, then segments with concurrency 6, 3 retries each.
5. Concatenate in order into one `Blob`. Extension: `.mp4` if `EXT-X-MAP` present (fMP4), else `.ts`.
6. Report progress to background → badge text `NN%`. Clear badge when done.
7. `ponytail:` whole file held as a Blob in memory; Chrome spills large blobs to disk, upgrade to
   File System Access streaming if multi-GB streams matter.

## Flow 5 — Live HLS (offscreen)

1. Same variant selection as VOD.
2. Loop: fetch media playlist, download segments with media sequence > last seen, append in order,
   sleep `TARGETDURATION` seconds. Badge `LIVE`.
3. Stops when user presses Stop (popup → background → offscreen) or playlist gains `EXT-X-ENDLIST`.
4. Saves as in VOD.

## Flow 6 — Tab recording

1. Popup "Record tab" → background calls `chrome.tabCapture.getMediaStreamId({ targetTabId })`
   (allowed because the popup was opened by user action) → passes id to offscreen.
2. Offscreen: `getUserMedia` with `chromeMediaSource: 'tab'` for audio+video; route audio to an
   `AudioContext` destination so the tab stays audible; `MediaRecorder` with `video/mp4` if
   `MediaRecorder.isTypeSupported`, else `video/webm`. Badge `REC`.
3. Stop → collect chunks → save.
4. DRM content records black — out of scope.

## State shared with popup

Background keeps `{ recording: bool, live: url|null, jobs: number }` in `storage.session` key `status`
so the popup can show Stop buttons correctly after being reopened.

## Error handling

- Segment fetch: 3 retries, then the job fails.
- Any job failure or `chrome.downloads` error: set `lastError`, badge `!`. Popup shows banner on next open.
- Non-OK HTTP (403, CORS) surfaces the status in the error text.

## Testing

- `test/hls.test.js` with `node --test`:
  master vs media detection, best variant by bandwidth, relative URL resolution,
  `EXT-X-MAP` init segment, `EXT-X-KEY` method, `EXT-X-ENDLIST` → VOD vs live,
  `EXT-X-MEDIA-SEQUENCE`, `EXT-X-TARGETDURATION`.
- Manual checklist in `README.md`: load unpacked, images page, direct mp4, public HLS VOD test stream,
  public live HLS test stream, tab recording with audio audible, error banner on a 403.
