const BrowserOSResponsive = (() => {
  const COMPACT = 1100;
  const MOBILE = 700;
  let resizeTimer = null;

  const viewport = () => ({
    width: Math.max(320, window.innerWidth || document.documentElement.clientWidth || 320),
    height: Math.max(320, window.innerHeight || document.documentElement.clientHeight || 320),
    top: Math.ceil(document.getElementById('topnav')?.getBoundingClientRect().height || 32)
  });

  function mode(){
    const w = viewport().width;
    return w < MOBILE ? 'mobile' : w < COMPACT ? 'compact' : 'desktop';
  }

  // The dock only reserves desktop real estate on genuinely wide screens.
  // Compact layouts use a side drawer; phones use a bottom sheet.
  function dockMode(){
    const w = viewport().width;
    if(w < MOBILE) return 'sheet';
    if(w < COMPACT) return 'overlay';
    return 'reserved';
  }
  function dockIsOverlay(){ return dockMode() !== 'reserved'; }
  function reservedRight(){
    if(dockMode() !== 'reserved') return 0;
    return window.BrowserOSDock?.getReservedWidth?.() || 0;
  }

  function applyBodyMode(){
    const m = mode();
    const dm = dockMode();
    document.body.classList.toggle('responsive-mobile', m === 'mobile');
    document.body.classList.toggle('responsive-compact', m === 'compact');
    document.body.classList.toggle('responsive-desktop', m === 'desktop');
    document.body.classList.toggle('dock-overlay-mode', dm === 'overlay');
    document.body.classList.toggle('dock-sheet-mode', dm === 'sheet');
    document.documentElement.style.setProperty('--viewport-width', `${viewport().width}px`);
    document.documentElement.style.setProperty('--viewport-height', `${viewport().height}px`);
  }

  function getGeometry(win){
    const rect = win?.g?.getBoundingClientRect?.();
    return {
      width: Math.max(1, rect?.width || Number(win?.width) || 500),
      height: Math.max(1, rect?.height || Number(win?.height) || 350),
      x: Number.isFinite(rect?.left) ? rect.left : (Number(win?.x) || 0),
      y: Number.isFinite(rect?.top) ? rect.top : (Number(win?.y) || viewport().top)
    };
  }

  function fitWindow(win){
    if(!win || !win.g || win.min) return;
    const vp = viewport();
    const right = reservedRight();
    const margin = mode() === 'mobile' ? 4 : 8;
    const usableW = Math.max(280, vp.width - right - margin * 2);
    const usableH = Math.max(180, vp.height - vp.top - margin * 2);

    // Keep WinBox drag/maximize/resize boundaries current, but do not continuously
    // resize the user's windows. Native WinBox remains responsible for interaction.
    win.top = vp.top;
    win.right = right;
    win.bottom = 0;
    win.left = 0;
    win.g.classList.remove('browseros-mobile-window');

    if(win.max) return;
    let {width, height, x, y} = getGeometry(win);
    let changedSize = false;

    // Only shrink a window if it physically cannot fit in the current viewport.
    if(width > usableW){ width = usableW; changedSize = true; }
    if(height > usableH){ height = usableH; changedSize = true; }
    if(changedSize) win.resize(Math.round(width), Math.round(height));

    const minX = margin;
    const maxX = Math.max(minX, vp.width - right - width - margin);
    const minY = vp.top + margin;
    const maxY = Math.max(minY, vp.height - height - margin);
    const nx = Math.max(minX, Math.min(x, maxX));
    const ny = Math.max(minY, Math.min(y, maxY));

    // Move only when the window is actually outside the usable area.
    if(Math.abs(nx - x) > 1 || Math.abs(ny - y) > 1) win.move(Math.round(nx), Math.round(ny));
  }

  function fitAll(){
    applyBodyMode();
    window.BrowserOSDock?.handleViewportResize?.();
    Object.values(window.openWindows || {}).forEach(win => fitWindow(win));
  }

  function responsiveDefaults(width, height){
    const vp = viewport();
    const right = reservedRight();
    const margin = mode() === 'mobile' ? 8 : 12;
    const usableW = Math.max(280, vp.width - right - margin * 2);
    const usableH = Math.max(180, vp.height - vp.top - margin * 2);
    let w = parseFloat(width) || 500;
    let h = parseFloat(height) || 350;

    // New windows get sensible caps, but remain ordinary movable/resizable WinBox windows.
    w = Math.min(w, usableW);
    h = Math.min(h, usableH);
    const result = {width:w, height:h};
    if(mode() === 'mobile'){
      result.x = margin;
      result.y = vp.top + margin;
    }
    return result;
  }

  function init(){
    applyBodyMode();
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(fitAll, 100);
    }, {passive:true});
    window.addEventListener('orientationchange', () => setTimeout(fitAll, 140), {passive:true});
    setTimeout(fitAll, 0);
  }

  return {init, mode, dockMode, dockIsOverlay, reservedRight, fitWindow, fitAll, responsiveDefaults};
})();
window.BrowserOSResponsive = BrowserOSResponsive;
