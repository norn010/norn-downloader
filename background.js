import { classify, cleanUrl, addItem, pageVideoItems, videoIdFromUrl } from './media.js';

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

// ---- Facebook videos with sound ----

// Runs inside the page: Facebook's embedded data, which holds ready-made MP4s with sound (see pageVideoItems).
function facebookData() {
  return [...document.querySelectorAll('script[type="application/json"]')]
    .map(s => s.textContent)
    .filter(t => t.includes('browser_native') || t.includes('"progressive_urls"'))
    .join('\n');
}

const inject = async (tabId, func) => (await chrome.scripting.executeScript({ target: { tabId }, func }))[0].result;

// Facebook only embeds a reel's data when its URL is loaded directly, not when reached by clicking or
// scrolling inside Facebook. Load the URL in a muted background tab, read the data, close the tab.
async function facebookDataViaTab(url) {
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
        reject(new Error('Facebook took too long to load'));
      }, 20_000);
      chrome.tabs.onUpdated.addListener(onUpdated);
      chrome.tabs.get(bg.id).then(t => t.status === 'complete' && done());
    });
    return await inject(bg.id, facebookData);
  } finally {
    chrome.tabs.remove(bg.id).catch(() => {});
  }
}

// With-sound items for the Facebook video in `url`: from the open tab when its page carries them, else via a
// background tab. Cached per video id for the session, so reopening the popup is instant.
async function facebookItems(tabId, url) {
  const id = videoIdFromUrl(url);
  const cacheKey = `fb:${id}`;
  if (id) {
    const { [cacheKey]: cached } = await store.get(cacheKey);
    if (cached) return cached;
  }
  let items = pageVideoItems((await inject(tabId, facebookData).catch(() => '')) ?? '', url);
  if (!items.length && id) items = pageVideoItems(await facebookDataViaTab(url), url);
  if (id && items.length) await store.set({ [cacheKey]: items });
  return items;
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg.type === 'fbItems') {
    facebookItems(msg.tabId, msg.url).then(items => reply({ items }), e => reply({ items: [], error: e.message }));
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
