import { classify, cleanUrl, addItem, markCurrent, pageVideoItems, videoIdFromUrl } from './media.js';

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

// An unread error outranks REC/LIVE until the popup dismisses it.
async function idleBadge() {
  const { status = {}, lastError } = await store.get(['status', 'lastError']);
  await chrome.action.setBadgeText({ text: lastError ? '!' : status.recording ? 'REC' : status.live ? 'LIVE' : '' });
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
// offscreen may already be gone, then so is the blob
const revoke = url => chrome.runtime.sendMessage({ target: 'offscreen', type: 'revoke', url }).catch(() => {});

const handlers = {
  progress: m => chrome.action.setBadgeText({ text: m.text }),
  status: m => setStatus(m.patch),
  error: m => fail(m.message),
  async save(m) {
    const download = filename => chrome.downloads.download({ url: m.url, filename, saveAs: false });
    try {
      // a capture can't be redone, so a name Chrome still refuses falls back to a plain one
      const id = await download(m.filename).catch(() => download(`norn-${Date.now()}.${m.filename.split('.').pop()}`));
      blobs.set(id, m.url);
    } catch (e) {
      revoke(m.url);
      return fail(`Save failed: ${e.message}`);
    }
    await idleBadge();
  },
  async clearError() {
    await store.set({ lastError: null });
    await idleBadge();
  },
};

// ---- Facebook / Instagram videos with sound ----

// Runs inside the page: the JSON blocks that hold ready-made MP4s with sound (parsed by pageVideoItems).
function pageData() {
  return [...document.querySelectorAll('script[type="application/json"]')]
    .map(s => s.textContent)
    .filter(t => /browser_native|"progressive_urls"|"video_versions"/.test(t));
}

const inject = async (tabId, func) => (await chrome.scripting.executeScript({ target: { tabId }, func }))[0].result;

// Facebook and Instagram only embed a video's data when its URL is loaded directly, not when it is reached by
// clicking or scrolling inside the site. Load the URL in a muted background tab, read the data, close the tab.
async function pageDataViaTab(url) {
  const bg = await chrome.tabs.create({ url, active: false });
  try {
    await chrome.tabs.update(bg.id, { muted: true });
    await new Promise((resolve, reject) => {
      const done = () => {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve();
      };
      const onUpdated = (id, info) => id === bg.id && info.status === 'complete' && done();
      const timer = setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(onUpdated);
        reject(new Error('The page took too long to load'));
      }, 20_000);
      chrome.tabs.onUpdated.addListener(onUpdated);
      chrome.tabs.get(bg.id).then(t => t.status === 'complete' && done());
    });
    return await inject(bg.id, pageData);
  } finally {
    chrome.tabs.remove(bg.id).catch(() => {});
  }
}

// With-sound items for the video in `url`: from the open tab when its page carries them, else via a background
// tab. Cached per video id for the session, so reopening the popup is instant.
async function siteVideoItems(tabId, url) {
  const id = videoIdFromUrl(url);
  const cacheKey = `video:${id}`;
  let { [cacheKey]: items } = id ? await store.get(cacheKey) : {};
  if (!items) {
    items = pageVideoItems((await inject(tabId, pageData).catch(() => [])) ?? [], url);
    if (!items.length && id) items = pageVideoItems((await pageDataViaTab(url)) ?? [], url);
    if (id && items.length) await store.set({ [cacheKey]: items });
  }
  // the viewer moves through a highlight without the URL changing, so ask the open page where it is each time
  if (id?.startsWith('highlight:')) items = markCurrent(items, await inject(tabId, storyPosition).catch(() => null));
  return items;
}

// Runs inside the page: which segment of the story progress bar is current. The bar is a thin row of segments
// where only the current one holds a fill element. ponytail: tied to Instagram's markup; without it, no item is
// marked current and the popup simply lists the highlight in order.
function storyPosition() {
  for (const row of document.querySelectorAll('div')) {
    const bars = [...row.children];
    if (bars.length < 2 || bars.some(b => b.tagName !== 'DIV')) continue;
    const h = row.getBoundingClientRect().height;
    if (!(h > 0 && h < 12)) continue;
    const filled = bars.filter(b => b.firstElementChild);
    if (filled.length === 1) return { count: bars.length, index: bars.indexOf(filled[0]) };
  }
  return null;
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg.type === 'videoItems') {
    siteVideoItems(msg.tabId, msg.url).then(items => reply({ items }), e => reply({ items: [], error: e.message }));
    return true; // answered later; the work finishes even if the popup closes
  }
  reply(); // ack so the sender's promise resolves; results travel as separate messages
  if (OFFSCREEN_JOBS.includes(msg.type)) toOffscreen(msg).catch(e => fail(e.message));
  else handlers[msg.type]?.(msg);
});

chrome.downloads.onChanged.addListener(({ id, state }) => {
  if (!blobs.has(id) || !state || state.current === 'in_progress') return;
  revoke(blobs.get(id));
  blobs.delete(id);
});
