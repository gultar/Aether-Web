(function initBrowserOS(){
  BackgroundManager.migrateLegacy().then(() => BackgroundManager.apply());
  if(window.WindowAppearanceManager) WindowAppearanceManager.init();

  ShortcutManager.render();
  SystemMonitor.start();
  BrowserOSContextMenu.init();
  if(window.BrowserOSDock) BrowserOSDock.init();
  if(window.BrowserOSResponsive) BrowserOSResponsive.init();

  const topDockButton=document.querySelector('#top-dock-button');
  if(topDockButton && window.BrowserOSDock){
    const syncTopDockButton=()=>{
      const visible=document.body.classList.contains('right-dock-visible');
      topDockButton.classList.toggle('active',visible);
      topDockButton.setAttribute('aria-pressed',visible?'true':'false');
      topDockButton.title=visible?'Hide Right Dock':'Show Right Dock';
    };
    topDockButton.addEventListener('click',e=>{e.stopPropagation();BrowserOSDock.toggle();syncTopDockButton()});
    new MutationObserver(syncTopDockButton).observe(document.body,{attributes:true,attributeFilter:['class']});
    syncTopDockButton();
  }

  // Original Browser-OS window manager lifecycle.
  cycleThroughWindows();
  loadWindowState();
  setInterval(saveWindowState, 30000);
  window.addEventListener('beforeunload', saveWindowState);

  const updateClock = () => {
    document.querySelector('#clock').textContent = new Date().toLocaleString([], {
      weekday:'short', month:'short', day:'numeric', hour:'2-digit', minute:'2-digit'
    });
  };
  updateClock();
  setInterval(updateClock,1000);

  const perfKey = 'browser-os-performance-mode';
  const applyPerformanceMode = enabled => {
    document.body.classList.toggle('performance-mode', !!enabled);
    localStorage.setItem(perfKey, enabled ? '1' : '0');
    const btn=document.querySelector('[data-action="performance"]');
    if(btn) btn.textContent=`Performance mode: ${enabled?'ON':'OFF'}`;
  };
  applyPerformanceMode(localStorage.getItem(perfKey)!=='0');

  const menuButton = document.querySelector('#main-menu-button');
  const menu = document.querySelector('#main-menu');
  const closeMenu = () => { menu.classList.remove('open'); menuButton.classList.remove('active'); menu.querySelectorAll('.menu-group.expanded').forEach(group=>group.classList.remove('expanded')); };
  menuButton.addEventListener('click', e => {
    e.stopPropagation();
    const open = !menu.classList.contains('open');
    closeMenu();
    if(open){ menu.classList.add('open'); menuButton.classList.add('active'); }
  });
  menu.addEventListener('click', e => {
    const folder = e.target.closest('.menu-folder');
    if(folder){
      e.stopPropagation();
      const group=folder.closest('.menu-group');
      const wasOpen=group.classList.contains('expanded');
      group.parentElement.querySelectorAll(':scope > .menu-group.expanded').forEach(item=>item.classList.remove('expanded'));
      if(!wasOpen)group.classList.add('expanded');
      return;
    }
    const button = e.target.closest('[data-action]');
    if(!button) return;
    e.stopPropagation();
    closeMenu();
    switch(button.dataset.action){
      case 'terminal': new TerminalWindow(); break;
      case 'system': new SystemWindow(); break;
      case 'right-dock': BrowserOSDock.toggle(); break;
      case 'ecosystem': new EcosystemWindow(); break;
      case 'tamagotchi': new TamagotchiWindow(); break;
      case 'news': new NewsWindow(); break;
      case 'weather': new WeatherWindow(); break;
      case 'calendar': new CalendarWindow(); break;
      case 'processes': new ProcessesWindow(); break;
      case 'network': new NetworkWindow(); break;
      case 'disks': new DisksWindow(); break;
      case 'services': new ServicesWindow(); break;
      case 'launcher': new LauncherWindow(); break;
      case 'clipboard': new ClipboardWindow(); break;
      case 'notes': new NotesWindow(); break;
      case 'todo': new TodoWindow(); break;
      case 'bookmarks': new BookmarksWindow(); break;
      case 'search': new SearchWindow(); break;
      case 'timers': new TimerWindow(); break;
      case 'background': new BackgroundWindow(); break;
      case 'appearance': new AppearanceWindow(); break;
      case 'voice-settings': new VoiceSettingsWindow(); break;
      case 'performance': applyPerformanceMode(!document.body.classList.contains('performance-mode')); break;
      case 'ai': new TinyAgentWindow(); break;
      case 'skills': new SkillEditorWindow(); break;
      case 'tooleditor': new ToolEditorWindow(); break;
      case 'cron': new ScheduledTasksWindow(); break;
      case 'osagent': new OSAgentWindow(); break;
      case 'research': new ResearchWindow(); break;
      case 'riftbreakers': new RiftbreakersWindow(); break;
      case 'geomancy': new GeomancyWindow(); break;
      case 'desktop-icons': ShortcutManager.openManager(); break;
      case 'add-shortcut': ShortcutManager.promptAdd(); break;
      case 'minimize': minimizeAllWindows(); break;
      case 'restore': restoreAllWindows(); break;
    }
  });
  // Add the same unified icon language to the main Browser-OS menu.
  const menuIcons={terminal:'terminal',system:'system','right-dock':'system',ecosystem:'system',tamagotchi:'todo',news:'news',weather:'weather',calendar:'agenda',processes:'processes',network:'network',disks:'disks',services:'services',launcher:'launcher',clipboard:'clipboard',notes:'notes',todo:'todo',bookmarks:'bookmarks',search:'search',timers:'timers',background:'background',appearance:'background','voice-settings':'ai',performance:'system',riftbreakers:'riftbreakers',geomancy:'geomancy',ai:'ai',skills:'skills',tooleditor:'skills',cron:'timers',osagent:'ai',research:'search','desktop-icons':'launcher','add-shortcut':'website',minimize:'minimize',restore:'restore'};
  menu.querySelectorAll('[data-action]').forEach(button=>{
    const icon=menuIcons[button.dataset.action];
    if(!icon || button.querySelector('.menu-svg'))return;
    const span=document.createElement('span');span.className='menu-svg';span.innerHTML=BrowserOSDesktopIcons.svg(icon);
    button.prepend(span);
  });

  document.addEventListener('click', closeMenu);

  window.addEventListener('keydown', e => {
    if(e.ctrlKey && e.altKey && e.key.toLowerCase()==='t'){
      e.preventDefault();
      new TerminalWindow();
    }
    if((e.ctrlKey || e.metaKey) && e.code === 'Space'){
      e.preventDefault();
      CommandPalette.open();
    }
  });
})();
