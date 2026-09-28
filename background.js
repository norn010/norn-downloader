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
