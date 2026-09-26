class NewsWindow {
  constructor(opts = {}) {
    const node = document.querySelector('#news-template').content.firstElementChild.cloneNode(true);
    document.querySelector('#window-mounts').appendChild(node);
    const select = node.querySelector('.feed-select');
    const list = node.querySelector('.news-list');
    const refreshBtn = node.querySelector('.refresh-news');
    const readKey = 'browser-os-rss-read';
    const getRead = () => { try { return new Set(JSON.parse(localStorage.getItem(readKey)) || []); } catch { return new Set(); } };
    const saveRead = set => localStorage.setItem(readKey, JSON.stringify([...set].slice(-500)));

    const loadFeeds = async () => {
      const feeds = await fetch('/api/feeds').then(r => r.json());
      select.innerHTML = feeds.map(f => `<option value="${f.key}">${f.name}</option>`).join('');
      select.value = localStorage.getItem('browser-os-feed') || 'cbc';
    };

    const load = async () => {
      list.innerHTML = '<div class="news-loading">Loading…</div>';
      try {
        const data = await fetch(`/api/rss?feed=${encodeURIComponent(select.value)}`, { cache: 'no-store' }).then(r => r.json());
        if (data.error) throw new Error(data.error);
        const read = getRead();
        list.innerHTML = data.items.map(item => {
          const date = item.date ? new Date(item.date).toLocaleString([], { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' }) : '';
          const id = btoa(unescape(encodeURIComponent(item.link))).replace(/=+$/,'');
          return `<button class="news-item ${read.has(id)?'read':''}" data-id="${id}" data-url="${encodeURIComponent(item.link)}"><span>${escapeHtml(item.title)}</span>${item.summary?`<span class="news-summary">${escapeHtml(item.summary)}</span>`:''}<small>${date}</small></button>`;
        }).join('') || '<div class="news-loading">No items.</div>';
        list.querySelectorAll('.news-item').forEach(el => el.addEventListener('click', () => { const r=getRead();r.add(el.dataset.id);saveRead(r);el.classList.add('read');window.open(decodeURIComponent(el.dataset.url), '_blank', 'noopener'); }));
      } catch (error) {
        list.innerHTML = `<div class="news-loading">RSS unavailable: ${escapeHtml(error.message)}</div>`;
      }
    };

    loadFeeds().then(load);
    select.addEventListener('change', () => { localStorage.setItem('browser-os-feed', select.value); load(); });
    refreshBtn.addEventListener('click', load);

    this.window = new ApplicationWindow({
      title: 'News', label: `news-${Date.now()}`, x: opts.x, y: opts.y,
      width: opts.width || '560', height: opts.height || '560', launcher: { name: 'NewsWindow', opts: { ...opts } },
      mount: node, onclose: () => node.remove()
    });
  }
}
function escapeHtml(value = '') { return String(value).replace(/[&<>'"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#039;','"':'&quot;'}[ch])); }
window.NewsWindow = NewsWindow;
