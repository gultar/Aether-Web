importScripts('bridge-config.js');

const bridge = globalThis.BROWSEROS_BRIDGE || {};
const baseUrl = String(bridge.baseUrl || 'http://127.0.0.1:8001').replace(/\/$/, '');
const token = String(bridge.token || '');

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set('X-BrowserOS-Outlook-Companion', token);
  if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const response = await fetch(baseUrl + path, { ...options, headers, cache: 'no-store' });
  let data = {};
  try { data = await response.json(); } catch {}
  if (!response.ok) throw new Error(data.error || `BrowserOS returned HTTP ${response.status}`);
  return data;
}

async function heartbeat() {
  if (!token) return { ok: false, error: 'Companion token is missing. Start BrowserOS once so it can prepare the extension.' };
  return api('/api/outlook/automation/heartbeat', {
    method: 'POST',
    body: JSON.stringify({ browser: navigator.userAgent })
  });
}

chrome.runtime.onInstalled.addListener(() => { heartbeat().catch(() => {}); });
chrome.runtime.onStartup.addListener(() => { heartbeat().catch(() => {}); });

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    const type = String(message?.type || '');
    if (type === 'BROWSEROS_HEARTBEAT') return heartbeat();
    if (type === 'GET_OUTLOOK_AUTOMATION_REQUEST') {
      await heartbeat().catch(() => {});
      const id = encodeURIComponent(String(message.requestId || ''));
      return api(`/api/outlook/automation/request/${id}`);
    }
    if (type === 'SET_OUTLOOK_AUTOMATION_STATUS') {
      const id = encodeURIComponent(String(message.requestId || ''));
      return api(`/api/outlook/automation/request/${id}/status`, {
        method: 'POST',
        body: JSON.stringify({
          status: String(message.status || ''),
          error: String(message.error || ''),
          detail: String(message.detail || '')
        })
      });
    }
    return { ok: false, error: 'Unknown BrowserOS Companion message.' };
  })().then(sendResponse).catch(error => sendResponse({ ok: false, error: String(error?.message || error) }));
  return true;
});
