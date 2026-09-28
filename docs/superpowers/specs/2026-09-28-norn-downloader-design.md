# Norn Downloader — Design

Date: 2026-09-28
Status: approved in chat; revised during planning (see "Revisions")

## Goal

Chrome extension (Manifest V3) that lets the user pick and download media from **any site**:
images, videos, HLS streams (VOD and live), plus a tab-recording fallback for everything else
(e.g. reels/stories served as `blob:` MSE video).

Success = open popup on a page → see found media with type/size/thumbnail → tick items →
download; HLS saves as one playable file; live HLS and tab recording can be started and stopped.

## Non-goals

- Site-specific extractors (Instagram/Facebook/TikTok APIs).
- DRM content (Widevine etc.) — not supported, no circumvention.
- Encrypted HLS (`EXT-X-KEY` with `METHOD` other than `NONE`) and byte-range HLS (`EXT-X-BYTERANGE`) — refused with a message pointing to tab recording.
- Merging separate audio renditions (`EXT-X-MEDIA TYPE=AUDIO`) — result is video-only; documented limitation.
- DASH (`.mpd`) parsing.
- Setting `Referer` for CDNs that check it — left as a `ponytail:` note (add via `declarativeNetRequest` when needed).

## Stack

Plain JavaScript ES modules, no build step, no runtime dependencies. `minimum_chrome_version` 116.
Tests use Node's built-in `node --test` (a `package.json` with `"type": "module"` exists only for Node).

## Files

| File | Responsibility |
|------|----------------|
| `manifest.json` | MV3 manifest, permissions |
| `background.js` | Service worker: network sniffing, per-tab media list, badge, offscreen lifecycle, message routing, saving offscreen results |
| `popup.html` / `popup.js` | UI: filters, list with checkboxes, download/record/stop buttons, one-shot page scan |
| `offscreen.html` / `offscreen.js` | Long jobs: HLS VOD download+merge, live HLS capture, tab recording via `MediaRecorder` |
| `media.js` | Pure helpers: `classify`, `cleanUrl`, `addItem`, `safeName`, `srcsetBest`, `mergeItems` |
| `hls.js` | Pure m3u8 parser + ordered download pool: `parse`, `pickBest`, `fetchInOrder` |
| `test/media.test.js`, `test/hls.test.js` | Node tests for the pure modules |
| `README.md` | Install + manual test checklist |

Pure modules never touch `chrome.*` or the DOM. No persistent content script: the popup injects a
one-shot scan function with `chrome.scripting.executeScript`.

## Permissions

`webRequest`, `downloads`, `scripting`, `activeTab`, `offscreen`, `tabCapture`, `storage`; host permission `<all_urls>`.

## Data model (`chrome.storage.session`)

- `tab:<tabId>` → array of `{ url, kind: 'image'|'video'|'audio'|'hls', mime, size /* bytes|null */ }`, oldest first, max 500.
- `status` → `{ recording: bool, live: bool }`.
- `lastError` → string or null.

## Flow 1 — Detection (background)

1. `webRequest.onResponseStarted` for `<all_urls>` with `responseHeaders`. Ignore `tabId < 0` (extension's own fetches) and `statusCode >= 400`.
2. A `main_frame` response clears that tab's list.
3. `classify(url, contentType)`: HLS by MIME or `.m3u8`; segments (`video/mp2t`, `video/iso.segment`, `.ts`, `.m4s`) → ignored; then `image/*|video/*|audio/*`; then extension (`jpg jpeg png gif webp avif svg` / `mp4 webm mov mkv` / `mp3 m4a aac ogg wav opus`); else ignored.
4. `size` = total from `Content-Range` (206 responses) else `Content-Length` else null. Images under 2 KB are ignored (icons, pixels).
5. URL stored through `cleanUrl` (drops `bytestart`/`byteend` params so IG/FB byte-range pieces become one full-file entry; other params byte-identical).
6. `addItem` dedupes by URL and keeps the newest 500. All storage read-modify-writes go through one serial queue.
7. `tabs.onRemoved` deletes the tab's key.

## Flow 2 — Popup

1. Reads `tab:<id>`, `status`, `lastError` straight from `storage.session`; injects `scanPage` into the tab (fails silently on `chrome://` pages).
2. `scanPage` returns `{ found: [{url, kind}], srcsets, base, blobVideo }` from `<img>/<video>/<audio>/<source>` (`currentSrc`/`src`/`poster`), `srcset` attributes, `og:image`/`og:video` meta, computed `background-image`.
3. `mergeItems(net, scan)`: network items newest first (they carry size), then page items (`classify(url) ?? tag kind`), then the largest candidate of each srcset. Only `http(s)` URLs, deduped after `cleanUrl`.
4. UI: filter buttons with counts (All / Images / Videos incl. audio / Streams), grid of cards (image thumbnail or type label, filename, size, checkbox), Select all (visible items), Download N, Record tab ⇄ Stop recording, Stop live (when `status.live`), `lastError` banner (dismiss → background clears it), hint when a `<video>` plays a `blob:` URL.
5. Page-derived strings only go into the DOM via `textContent`/properties, never `innerHTML`.

## Flow 3 — Downloads

- `image`/`video`/`audio`: popup calls `chrome.downloads.download({ url, saveAs: false })`; errors collected and shown in the banner.
- `hls`: popup sends `{ type: 'hls', url, name }` to background → offscreen.
- Offscreen cannot call `chrome.downloads`: it makes a blob URL and sends `{ type: 'save', url, filename }`; background downloads it and asks offscreen to revoke the blob URL when the download leaves `in_progress`.
- `name` = `safeName(tab.title)` (Windows-forbidden chars → `_`, trimmed dots/spaces, 100 code points max, fallback `norn`).

## Flow 4 — HLS (offscreen)

1. Fetch + `parse`; if master, `pickBest` (highest `BANDWIDTH`) and parse that media playlist.
2. `unsupported` set (encrypted / byte-range) → error "… — use Record tab instead".
3. `ended` (has `EXT-X-ENDLIST`) → VOD; otherwise → live.
4. VOD: `fetchInOrder` segments, 6 in flight, each fetch retried 3× (500 ms, 1 s backoff); stops scheduling after the first failure. Progress → badge `NN%`. Prepend `EXT-X-MAP` init if present. Save as `.mp4` if init present (fMP4) else `.ts`.
5. Live: `status.live = true`, badge `LIVE`. Loop: download segments with `seq` > last seen, sleep `TARGETDURATION` s (2 s if missing), re-fetch playlist; ends on Stop or `EXT-X-ENDLIST`. Whatever was captured is saved even when the loop fails.
6. `ponytail:` the whole file is one in-memory Blob; stream to disk if multi-GB matters.

## Flow 5 — Tab recording

1. Popup click → `chrome.tabCapture.getMediaStreamId({ targetTabId })` in the popup (user gesture) → `{ type: 'record', streamId, name }` → background → offscreen.
2. Offscreen: `getUserMedia` tab audio+video (caps 1920×1080 @30 fps), route audio to an `AudioContext` so the tab stays audible, `MediaRecorder` with first supported of `video/mp4;codecs=avc1,mp4a.40.2`, `video/webm;codecs=vp9,opus`, `video/webm`. Badge `REC`.
3. Stop button, or the captured tab closing, stops the recorder and saves.
4. One recording at a time. DRM content records black — out of scope.

## Messaging

`chrome.runtime.sendMessage` everywhere. Messages for offscreen carry `target: 'offscreen'`. Every
receiving listener calls `reply()` immediately (ack) so senders' promises resolve; results travel as
separate messages. Popup → background: `hls`, `record`, `stop {what: 'record'|'live'}`, `clearError`.
Offscreen → background: `progress {text}`, `status {patch}`, `save {url, filename}`, `error {message}`.
Background → offscreen: `hls`, `record`, `stop`, `revoke {url}`.

## Error handling

- Segment fetch: 3 attempts, then the job fails; non-OK HTTP reported as `HTTP <status> for <url>`.
- Any job failure or save failure: `lastError` set, badge `!`; popup shows the banner until dismissed.
- `stop` when no offscreen document exists: background resets `status`.

## Testing

- `node --test`: `classify`, `cleanUrl`, `addItem`, `safeName`, `srcsetBest`, `mergeItems`, `parse`, `pickBest`, `fetchInOrder`.
- Manual checklist in `README.md`: load unpacked, image page, direct mp4, HLS VOD (TS and fMP4), live HLS + Stop, tab recording with audio audible, tab closed mid-recording, error banner.

## Revisions (during planning)

- Added `media.js` (pure, tested) for classification, URL cleanup, filenames, srcset, merging.
- Live vs VOD is decided by offscreen after resolving the playlist; the popup no longer fetches playlists. One "Download" path for all streams; "Stop live" appears while a live capture runs.
- `status.live` is a boolean; `jobs` counter dropped (unused).
- Byte-range playlists refused like encrypted ones; error responses (≥ 400) not listed; list capped at 500.
