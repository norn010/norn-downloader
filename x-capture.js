// Runs in x.com / twitter.com pages (MAIN world, document_start). X fetches tweets through its own API, even for
// protected accounts you follow, and never embeds them in the page. Copy responses that carry video data into
// hidden <script type="application/json"> blocks, where the extension's pageData() reads them.
// Read-only: responses reach X untouched. ponytail: keeps the newest 20 responses; raise if long scrolls miss videos.
(() => {
  const KEEP = 20;
  const keep = text => {
    if (typeof text !== 'string' || !text.includes('"video_info"')) return;
    const block = Object.assign(document.createElement('script'), { type: 'application/json', textContent: text });
    block.dataset.norn = '';
    document.documentElement.append(block);
    const all = document.querySelectorAll('script[data-norn]');
    for (let i = 0; i < all.length - KEEP; i++) all[i].remove();
  };

  // X puts a clean XMLHttpRequest.prototype.open back after load; as an accessor, whatever it assigns becomes the
  // function we wrap instead of replacing the wrapper.
  const proto = XMLHttpRequest.prototype;
  let open = proto.open;
  const wrapped = function (...args) {
    this.addEventListener('load', () => {
      try {
        if (this.responseType === '' || this.responseType === 'text') keep(this.responseText);
        else if (this.responseType === 'json') keep(JSON.stringify(this.response));
      } catch {
        // never disturb the page
      }
    });
    return open.apply(this, args);
  };
  Object.defineProperty(proto, 'open', {
    configurable: true,
    enumerable: true,
    get: () => wrapped,
    set: fn => {
      open = fn;
    },
  });

  const fetch = window.fetch;
  window.fetch = async function (...args) {
    const res = await fetch.apply(this, args);
    try {
      if (/\/graphql\//.test(res.url)) res.clone().text().then(keep, () => {});
    } catch {
      // never disturb the page
    }
    return res;
  };
})();
