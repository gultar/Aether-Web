class RiftbreakersWindow {
  constructor(opts = {}) {
    const host = document.createElement('section');
    host.className = 'riftbreakers-host';

    const frame = document.createElement('iframe');
    frame.className = 'riftbreakers-frame';
    frame.src = './apps/riftbreakers-vtt.html';
    frame.title = 'Riftbreakers 2e Virtual Tabletop';
    frame.allow = 'clipboard-read; clipboard-write; fullscreen';
    host.appendChild(frame);
    document.querySelector('#window-mounts').appendChild(host);

    const width = opts.width || Math.max(760, Math.min(window.innerWidth - 80, 1440));
    const height = opts.height || Math.max(560, Math.min(window.innerHeight - 90, 920));

    this.window = new ApplicationWindow({
      title: 'Riftbreakers 2e — Virtual Tabletop',
      label: opts.label || 'Riftbreakers VTT',
      x: opts.x === undefined ? 'center' : opts.x,
      y: opts.y === undefined ? 'center' : opts.y,
      width,
      height,
      launcher: { name: 'RiftbreakersWindow', opts: { ...opts, width, height } },
      mount: host,
      onclose: () => host.remove()
    });
  }
}

window.RiftbreakersWindow = RiftbreakersWindow;
