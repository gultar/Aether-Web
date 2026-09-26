(() => {
  const ping = () => chrome.runtime.sendMessage({ type: 'BROWSEROS_HEARTBEAT' }, () => void chrome.runtime.lastError);
  ping();
  const timer = setInterval(ping, 15000);
  addEventListener('pagehide', () => clearInterval(timer), { once: true });
})();
