import { hideFacebookPieces, mergeItems, safeName, videoIdFromUrl } from './media.js';

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

const fbVideoPage = videoIdFromUrl(tab.url) !== null;
let fbLoading = fbVideoPage; // background fetches the with-sound files; see the fbItems request below
const items = hideFacebookPieces(mergeItems(net, scan), tab.url);
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
      : item.label // page-provided video: show its first frame
        ? Object.assign(document.createElement('video'), { src: item.url, preload: 'metadata', muted: true })
        : Object.assign(document.createElement('div'), { textContent: item.kind.toUpperCase() });
  thumb.classList.add('thumb');
  const meta = document.createElement('small');
  meta.textContent = item.label ?? [fileName(item.url), fmtSize(item.size)].filter(Boolean).join(' · ');
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
  $('#grid').replaceChildren(...(list.length ? list.map(card) : fbLoading ? [] : [empty]));
  $('#fbLoading').hidden = !fbLoading;
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
      else await chrome.downloads.download({ url: item.url, saveAs: false, ...(item.filename && { filename: item.filename }) });
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
$('#hint').hidden = !scan.blobVideo || fbVideoPage;
render();

// Facebook with-sound MP4s (HD/SD) go on top; background may open a hidden tab to get them (a few seconds).
const fb = await chrome.runtime.sendMessage({ type: 'fbItems', tabId: tab.id, url: tab.url }).catch(e => ({ error: e.message }));
fbLoading = false;
const known = new Set(items.map(i => i.url));
items.unshift(...(fb?.items ?? []).filter(i => !known.has(i.url)));
if (fbVideoPage && !fb?.items?.length) showError(fb?.error ?? "Couldn't find this video's file with sound. Try Record tab.");
render();
