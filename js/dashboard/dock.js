const BrowserOSDock = (() => {
  const STORAGE_KEY = 'browser-os-right-dock-v1';
  const DEFAULT_STATE = {
    visible: true,
    width: 500,
    panels: [
      { type: 'terminal', size: 0.58, pinned: true },
      { type: 'system', size: 0.42, pinned: true }
    ]
  };

  let state = loadState();
  let root = null;
  let panelsRoot = null;
  let terminalCounter = 0;
  const cleanups = new Map();

  function loadState(){
    try{
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if(!saved || !Array.isArray(saved.panels)) return structuredClone(DEFAULT_STATE);
      return {
        visible: saved.visible !== false,
        width: Math.max(330, Math.min(760, Number(saved.width) || DEFAULT_STATE.width)),
        panels: saved.panels.filter(p => ['terminal','system','ecosystem','tamagotchi'].includes(p.type)).map(p => ({
          type: p.type,
          size: Math.max(.16, Number(p.size) || .5),
          pinned: p.pinned !== false
        }))
      };
    }catch(_){ return structuredClone(DEFAULT_STATE); }
  }

  function saveState(){
    // Only pinned panels survive a Browser-OS reload. Unpinned panels remain
    // active for the current session but intentionally disappear next time.
    const pinnedPanels = state.panels.filter(p => p.pinned !== false);
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      visible: state.visible && pinnedPanels.length > 0,
      width: state.width,
      panels: pinnedPanels
    }));
  }

  function normalizeSizes(){
    if(!state.panels.length) return;
    const total = state.panels.reduce((sum,p)=>sum+(Number(p.size)||0),0) || 1;
    state.panels.forEach(p => p.size = (Number(p.size)||1) / total);
  }

  function init(){
    root = document.getElementById('right-dock');
    panelsRoot = root?.querySelector('.right-dock-panels');
    if(!root || !panelsRoot) return;
    bindWidthHandle();
    render();
  }

  function render(){
    if(!root || !panelsRoot) return;
    root.classList.toggle('hidden', !state.visible);
    root.style.width = `${state.width}px`;
    document.documentElement.style.setProperty('--right-dock-width', state.visible && !(window.BrowserOSResponsive?.dockIsOverlay?.()) ? `${state.width}px` : '0px');
    document.body.classList.toggle('right-dock-visible', state.visible);
    document.body.classList.toggle('right-dock-overlay-visible', state.visible && !!window.BrowserOSResponsive?.dockIsOverlay?.());

    for(const dispose of cleanups.values()) try{ dispose(); }catch(_){}
    cleanups.clear();
    panelsRoot.innerHTML = '';
    normalizeSizes();

    state.panels.forEach((panel, index) => {
      const shell = document.createElement('section');
      shell.className = `dock-panel dock-panel-${panel.type}`;
      shell.dataset.type = panel.type;
      shell.style.flex = `${Math.max(.1,panel.size)} 1 0`;
      shell.innerHTML = `
        <header class="dock-panel-head">
          <strong>${panel.type === 'terminal' ? 'Terminal' : panel.type === 'system' ? 'System' : panel.type === 'ecosystem' ? 'Ecosystem' : 'Tamagotchi'}</strong>
          <div class="dock-panel-actions">
            <button type="button" data-dock-action="pin" title="${panel.pinned ? 'Unpin from saved layout' : 'Pin to saved layout'}">${panel.pinned ? '●' : '○'}</button>
            <button type="button" data-dock-action="detach" title="Detach to window">↗</button>
            <button type="button" data-dock-action="remove" title="Remove from dock">×</button>
          </div>
        </header>
        <div class="dock-panel-body"></div>`;
      panelsRoot.appendChild(shell);
      shell.querySelector('[data-dock-action="pin"]').addEventListener('click',()=>togglePin(panel.type));
      shell.querySelector('[data-dock-action="detach"]').addEventListener('click',()=>detach(panel.type));
      shell.querySelector('[data-dock-action="remove"]').addEventListener('click',()=>remove(panel.type));
      const body = shell.querySelector('.dock-panel-body');
      if(panel.type === 'terminal') mountTerminal(body, panel.type);
      if(panel.type === 'system') mountSystem(body, panel.type);
      if(panel.type === 'ecosystem') mountEcosystem(body, panel.type);
      if(panel.type === 'tamagotchi') mountTamagotchi(body, panel.type);

      if(index < state.panels.length - 1){
        const divider = document.createElement('div');
        divider.className = 'dock-row-resizer';
        divider.title = 'Drag to resize panels';
        panelsRoot.appendChild(divider);
        bindRowResizer(divider, index);
      }
    });
    saveState();
  }

  function mountTerminal(host, key){
    const id = `dock-${Date.now()}-${++terminalCounter}`;
    host.innerHTML = `<div id="terminal-window-${id}" class="terminal-window dock-terminal-window" style="visibility:visible"><div id="container-${id}" class="container"><output id="output-${id}" class="output"></output><div id="input-line-${id}" class="input-line"><div id="prompt-${id}" class="prompt"></div><div><input tabindex="0" id="cmdline-${id}" class="cmdline" autofocus></div></div></div></div>`;
    const term = new Terminal(id);
    term.init();
    cleanups.set(key, () => {
      try{ term.activeOSAbortController?.abort(); }catch(_){}
    });
  }

  function mountSystem(host, key){
    const node = document.querySelector('#system-template').content.firstElementChild.cloneNode(true);
    node.classList.add('docked-system-widget');
    host.appendChild(node);
    const update = window.renderSystemMonitorData || (()=>{});
    const unsubscribe = SystemMonitor.subscribe(data => update(node, data));
    cleanups.set(key, unsubscribe);
  }

  function mountEcosystem(host, key){
    const dispose = window.EcosystemWidget?.mount(host, {docked:true}) || (()=>{});
    cleanups.set(key, dispose);
  }

  function mountTamagotchi(host, key){
    const dispose = window.TamagotchiWidget?.mount(host, {docked:true}) || (()=>{});
    cleanups.set(key, dispose);
  }

  function bindWidthHandle(){
    const handle = root.querySelector('.right-dock-width-handle');
    if(!handle) return;
    handle.addEventListener('pointerdown', event => {
      event.preventDefault();
      handle.setPointerCapture(event.pointerId);
      const startX = event.clientX;
      const startWidth = state.width;
      const move = e => {
        const dockMode = window.BrowserOSResponsive?.dockMode?.() || 'reserved';
        if(dockMode === 'sheet') return;
        const minWidth = 330;
        const maxWidth = dockMode === 'overlay' ? window.innerWidth * .92 : Math.min(760, window.innerWidth * .48);
        state.width = Math.max(minWidth, Math.min(maxWidth, startWidth + (startX - e.clientX)));
        root.style.width = `${state.width}px`;
        document.documentElement.style.setProperty('--right-dock-width', `${state.width}px`);
      };
      const up = e => {
        handle.releasePointerCapture(e.pointerId);
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        saveState();
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
    });
  }

  function bindRowResizer(divider, index){
    divider.addEventListener('pointerdown', event => {
      event.preventDefault();
      divider.setPointerCapture(event.pointerId);
      const before = state.panels[index], after = state.panels[index+1];
      const total = before.size + after.size;
      const startY = event.clientY;
      const available = Math.max(200, panelsRoot.getBoundingClientRect().height);
      const startBefore = before.size;
      const move = e => {
        const delta = (e.clientY - startY) / available;
        const next = Math.max(.16, Math.min(total - .16, startBefore + delta));
        before.size = next; after.size = total - next;
        const panelEls = [...panelsRoot.querySelectorAll('.dock-panel')];
        panelEls[index].style.flex = `${before.size} 1 0`;
        panelEls[index+1].style.flex = `${after.size} 1 0`;
      };
      const up = e => {
        divider.releasePointerCapture(e.pointerId);
        divider.removeEventListener('pointermove', move);
        divider.removeEventListener('pointerup', up);
        saveState();
      };
      divider.addEventListener('pointermove', move);
      divider.addEventListener('pointerup', up);
    });
  }

  function refit(){ setTimeout(()=>window.BrowserOSResponsive?.fitAll?.(),0); }
  function toggle(){ state.visible = !state.visible; render(); refit(); }
  function show(){ if(!state.visible){ state.visible = true; render(); refit(); } }
  function hide(){ if(state.visible){ state.visible = false; render(); refit(); } }
  function has(type){ return state.panels.some(p=>p.type===type); }
  function dock(type){
    if(!['terminal','system','ecosystem','tamagotchi'].includes(type)) return false;
    const existing = state.panels.find(p=>p.type===type);
    if(!existing) state.panels.push({type,size: state.panels.length ? .35 : 1,pinned:true});
    state.visible = true;
    render(); refit();
    return true;
  }
  function remove(type){
    state.panels = state.panels.filter(p=>p.type!==type);
    if(!state.panels.length) state.visible = false;
    render(); refit();
  }
  function togglePin(type){
    const p = state.panels.find(p=>p.type===type); if(!p) return;
    p.pinned = !p.pinned; render();
  }
  function detach(type){
    remove(type);
    if(type === 'terminal') new TerminalWindow();
    if(type === 'system') new SystemWindow();
    if(type === 'ecosystem') new EcosystemWindow();
    if(type === 'tamagotchi') new TamagotchiWindow();
  }
  function getReservedWidth(){ return state.visible && !(window.BrowserOSResponsive?.dockIsOverlay?.()) ? state.width : 0; }
  function handleViewportResize(){
    const dockMode = window.BrowserOSResponsive?.dockMode?.() || 'reserved';
    const overlay = dockMode !== 'reserved';
    const min = dockMode === 'sheet' ? Math.min(280, window.innerWidth) : 330;
    const max = dockMode === 'reserved' ? Math.max(min, Math.min(760, window.innerWidth * .48)) : Math.max(min, window.innerWidth * .92);
    state.width = Math.max(min, Math.min(state.width, max));
    if(root && dockMode !== 'sheet'){ root.style.width = `${state.width}px`; }
    if(root && dockMode === 'sheet'){ root.style.removeProperty('width'); }
    document.documentElement.style.setProperty('--right-dock-width', state.visible && !overlay ? `${state.width}px` : '0px');
    document.body.classList.toggle('dock-overlay-mode', dockMode === 'overlay');
    document.body.classList.toggle('dock-sheet-mode', dockMode === 'sheet');
    document.body.classList.toggle('right-dock-overlay-visible', state.visible && overlay);
  }

  return { init, toggle, show, hide, dock, detach, remove, has, getReservedWidth, handleViewportResize };
})();
window.BrowserOSDock = BrowserOSDock;
