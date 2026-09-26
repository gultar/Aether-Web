class BrowserOSStorage {
  constructor(opts = {}) { this.prefix = opts.prefix || 'browser-os:'; }
  set(key, value) { localStorage.setItem(this.prefix + key, JSON.stringify(value)); return value; }
  get(key) {
    const raw = localStorage.getItem(this.prefix + key);
    if (raw === null) return {};
    try { return JSON.parse(raw); } catch (_) { return raw; }
  }
  remove(key) { localStorage.removeItem(this.prefix + key); }
}
window.BrowserOSStorage = BrowserOSStorage;
