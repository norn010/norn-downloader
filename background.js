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
