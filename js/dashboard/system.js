const SystemMonitor = {
  last: null,
  listeners: new Set(),
  timer: null,
  intervalMs: 5000,

  async refresh() {
    try {
      const response = await fetch('/api/system', { cache: 'no-store' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'System API failed');
      this.last = data;
      this.listeners.forEach(fn => fn(data));
      this.updateTopbar(data);
    } catch (error) {
      console.warn('System monitor:', error);
    }
  },

  start() {
    if (this.timer) return;
    const poll = async () => {
      await this.refresh();
      const delay = document.hidden ? 15000 : this.intervalMs;
      this.timer = setTimeout(poll, delay);
    };
    poll();
  },

  subscribe(fn) {
    this.listeners.add(fn);
    if (this.last) fn(this.last);
    return () => this.listeners.delete(fn);
  },

  updateTopbar(data) {
    const ramPct = data.memory?.total ? Math.round((data.memory.used / data.memory.total) * 100) : 0;
    document.querySelector('#top-cpu').textContent = `CPU ${data.cpu?.load ?? '--'}%`;
    document.querySelector('#top-ram').textContent = `RAM ${ramPct}%`;
  }
};

function bytesToGiB(bytes) {
  return `${(bytes / 1073741824).toFixed(1)} GB`;
}

function systemEsc(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
}

async function openSystemDrive(mount) {
  const response = await fetch('/api/system/open-drive', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({mount})
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Could not open drive.');
  return data;
}

function setDiskCardStatus(card, message, isError = false) {
  const status = card.querySelector('[data-drive-status]');
  if (!status) return;
  status.textContent = message;
  status.classList.toggle('is-error', !!isError);
}

function bindSystemDiskCards(host) {
  host.querySelectorAll('[data-open-drive]').forEach(card => {
    if (card.dataset.driveBound === '1') return;
    card.dataset.driveBound = '1';

    const activate = async event => {
      if (event.type === 'keydown' && event.key !== 'Enter' && event.key !== ' ') return;
      if (event.type === 'keydown') event.preventDefault();
      event.stopPropagation();
      const mount = card.dataset.openDrive;
      if (!mount || card.classList.contains('is-opening')) return;

      card.classList.add('is-opening');
      setDiskCardStatus(card, 'Opening File Explorer…');
      try {
        await openSystemDrive(mount);
        setDiskCardStatus(card, 'Opened in File Explorer');
        setTimeout(() => setDiskCardStatus(card, 'Click to open'), 1600);
      } catch (error) {
        console.error('Could not open drive:', error);
        setDiskCardStatus(card, error.message || 'Could not open drive', true);
      } finally {
        card.classList.remove('is-opening');
      }
    };

    card.addEventListener('click', activate);
    card.addEventListener('keydown', activate);
  });
}

function renderSystemDisks(node, data) {
  let host = node.querySelector('[data-disks]');
  if (!host) {
    const legacy = node.querySelector('[data-stat="disk"]')?.closest('.stat-card');
    if (!legacy) return;
    host = document.createElement('div');
    host.className = 'system-disk-cards';
    host.dataset.disks = '';
    legacy.replaceWith(host);
  }

  const disks = Array.isArray(data.disks) && data.disks.length
    ? data.disks
    : (data.disk ? [data.disk] : []);

  if (!disks.length) {
    host.innerHTML = '<article class="stat-card wide"><span>Disks</span><strong>Unavailable</strong><small>No mounted filesystems reported</small></article>';
    return;
  }

  host.innerHTML = disks.map(d => {
    const pct = Math.max(0, Math.min(100, Math.round(Number(d.use) || 0)));
    const size = Number(d.size) || 0;
    const used = Number(d.used) || 0;
    const free = Number.isFinite(Number(d.available)) ? Number(d.available) : Math.max(0, size - used);
    const label = d.mount || d.fs || 'Disk';
    const type = d.type ? ` · ${systemEsc(d.type)}` : '';
    const driveRoot = /^[A-Za-z]:\\?$/.test(String(label).trim()) ? String(label).trim().slice(0,2).toUpperCase() + "\\" : "";
    const interactive = driveRoot ? ` role="button" tabindex="0" data-open-drive="${systemEsc(driveRoot)}" title="Open ${systemEsc(driveRoot)} in File Explorer"` : "";
    return `<article class="stat-card wide system-disk-card${driveRoot?' is-clickable':''}"${interactive}>
      <span>Disk ${systemEsc(label)}</span>
      <strong>${pct}%</strong>
      <div class="meter"><i style="width:${pct}%"></i></div>
      <small>${bytesToGiB(used)} / ${bytesToGiB(size)} · ${bytesToGiB(free)} free${type}</small>
      ${driveRoot?'<small class="drive-open-status" data-drive-status>Click to open</small>':''}
    </article>`;
  }).join('');

  bindSystemDiskCards(host);
}
function renderCpuTopology(node, data) {
  const loads = data.cpu?.cores || [];
  const cores = node.querySelector('[data-cores]');
  if (!cores) return;

  const logical = Number(data.cpu?.logicalProcessors) || loads.length;
  const physical = Number(data.cpu?.physicalCores) || 0;
  const processors = Number(data.cpu?.processors) || 1;
  const card = cores.closest('.stat-card');
  const label = card ? Array.from(card.children).find(el => el.tagName === 'SPAN') : null;
  if (label) {
    const topology = physical
      ? `${physical} core${physical===1?'':'s'} / ${logical} thread${logical===1?'':'s'}`
      : `${logical} logical processor${logical===1?'':'s'}`;
    label.textContent = `CPU activity · ${topology}${processors>1?` · ${processors} sockets`:''}`;
  }

  cores.innerHTML = loads.map((v,i) => `<div title="Logical processor ${i+1}: ${v}%"><span>${i+1}</span><i><b style="width:${Math.max(0,Math.min(100,v))}%"></b></i><small>${v}%</small></div>`).join('');
}

function formatUptime(seconds = 0) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  return `${days}d ${hours}h ${mins}m`;
}

function renderSystemMonitorData(node, data) {
  const ramPct = data.memory?.total ? Math.round((data.memory.used / data.memory.total) * 100) : 0;
  const gpuPct = Number.isFinite(data.gpu?.utilization) ? Math.round(data.gpu.utilization) : 0;
  const vramPct = data.gpu?.memoryTotalMb ? Math.round((data.gpu.memoryUsedMb / data.gpu.memoryTotalMb) * 100) : 0;
  const values = { cpu: data.cpu?.load || 0, ram: ramPct, gpu: gpuPct, vram: vramPct };

  for (const [key, value] of Object.entries(values)) {
    const stat = node.querySelector(`[data-stat="${key}"]`);
    const bar = node.querySelector(`[data-bar="${key}"]`);
    if (stat) stat.textContent = `${value}%`;
    if (bar) bar.style.width = `${Math.max(0, Math.min(100, value))}%`;
  }

  const extraCpu=node.querySelector('[data-extra="cpu"]');
  if(extraCpu) {
    const temp = data.cpu?.temperature ? `${data.cpu.temperature}°C` : '';
    const brand = data.cpu?.brand || '';
    extraCpu.textContent = [brand,temp].filter(Boolean).join(' · ');
  }
  const extraRam=node.querySelector('[data-extra="ram"]'); if(extraRam) extraRam.textContent = data.memory ? `${bytesToGiB(data.memory.used)} / ${bytesToGiB(data.memory.total)}` : '';
  const extraGpu=node.querySelector('[data-extra="gpu"]'); if(extraGpu) extraGpu.textContent = data.gpu ? `${data.gpu.name || 'GPU'}${data.gpu.temperature ? ` · ${data.gpu.temperature}°C` : ''}` : 'Unavailable';
  const extraVram=node.querySelector('[data-extra="vram"]'); if(extraVram) extraVram.textContent = data.gpu?.memoryTotalMb ? `${(data.gpu.memoryUsedMb / 1024).toFixed(1)} / ${(data.gpu.memoryTotalMb / 1024).toFixed(1)} GB` : 'Unavailable';

  renderSystemDisks(node, data);
  renderCpuTopology(node, data);

  const uptime=node.querySelector('[data-stat="uptime"]'); if(uptime) uptime.textContent = formatUptime(data.uptime);
  const battery = data.battery;
  const batteryStat=node.querySelector('[data-stat="battery"]'); if(batteryStat) batteryStat.textContent = battery?.hasBattery ? `${Math.round(battery.percent || 0)}%` : 'AC';
  const batteryExtra=node.querySelector('[data-extra="battery"]'); if(batteryExtra) batteryExtra.textContent = battery?.hasBattery ? `${battery.isCharging ? 'Charging' : 'On battery'}${battery.timeRemaining ? ` · ${battery.timeRemaining} min` : ''}` : 'No battery reported';
}

class SystemWindow {
  constructor(opts = {}) {
    const node = document.querySelector('#system-template').content.firstElementChild.cloneNode(true);
    document.querySelector('#window-mounts').appendChild(node);
    const unsubscribe = SystemMonitor.subscribe(data => renderSystemMonitorData(node, data));
    this.window = new ApplicationWindow({
      title: 'System', label: `system-${Date.now()}`,
      x: opts.x, y: opts.y, width: opts.width || '620', height: opts.height || '430',
      launcher: { name: 'SystemWindow', opts: { ...opts } },
      mount: node,
      onclose: () => { unsubscribe(); node.remove(); }
    });
    if(window.BrowserOSDock){
      this.window.addControl({index:0,class:'wb-dock',image:'./images/dock.svg',click:(_event, winbox)=>{ BrowserOSDock.dock('system'); winbox.close(); }});
    }
  }
}

function ensureSystemMonitorStyles() {
  if (document.getElementById('browseros-system-monitor-v2-styles')) return;
  const style = document.createElement('style');
  style.id = 'browseros-system-monitor-v2-styles';
  style.textContent = `
    .system-disk-cards { display: contents; }
    .system-disk-card small { white-space: normal; line-height: 1.25; }
    .system-disk-card.is-clickable { cursor: pointer; transition: transform .12s ease, border-color .12s ease, background .12s ease; }
    .system-disk-card.is-clickable:hover { transform: translateY(-1px); border-color: rgba(145,169,208,.7); background: rgba(145,169,208,.06); }
    .system-disk-card.is-clickable:focus-visible { outline: 2px solid rgba(145,169,208,.9); outline-offset: 2px; }
    .system-disk-card.is-opening { transform: scale(.99); opacity: .86; }
    .drive-open-status { display:block; margin-top:5px; color:rgba(145,169,208,.95); font-weight:700; }
    .drive-open-status.is-error { color:#ef8f8f; }
  `;
  document.head.appendChild(style);
}
ensureSystemMonitorStyles();

window.renderSystemMonitorData = renderSystemMonitorData;
window.SystemWindow = SystemWindow;
window.SystemMonitor = SystemMonitor;
