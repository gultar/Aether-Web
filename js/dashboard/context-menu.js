(function(){
  const actions = {
    terminal: () => new TerminalWindow(), system: () => new SystemWindow(), news: () => new NewsWindow(),
    weather: () => new WeatherWindow(), calendar: () => new CalendarWindow(), processes: () => new ProcessesWindow(),
    network: () => new NetworkWindow(), disks: () => new DisksWindow(), services: () => new ServicesWindow(),
    launcher: () => new LauncherWindow(), clipboard: () => new ClipboardWindow(), notes: () => new NotesWindow(),
    todo: () => new TodoWindow(), bookmarks: () => new BookmarksWindow(), search: () => new SearchWindow(),
    timers: () => new TimerWindow(), background: () => new BackgroundWindow(), appearance: () => new AppearanceWindow(), riftbreakers: () => new RiftbreakersWindow(), geomancy: () => new GeomancyWindow(), ai: () => new TinyAgentWindow(), skills: () => new SkillEditorWindow(), tooleditor: () => new ToolEditorWindow(), cron: () => new ScheduledTasksWindow(), osagent: () => new OSAgentWindow(), research: () => new ResearchWindow(), palette: () => CommandPalette.open(),
    'add-shortcut': () => ShortcutManager.addWebsite(), 'desktop-icons': () => ShortcutManager.openManager(), 'align-icons': () => ShortcutManager.alignToGrid(), minimize: () => minimizeAllWindows(),
    restore: () => restoreAllWindows(), refresh: () => location.reload()
  };

  const actionIcon = {terminal:'terminal',system:'system',news:'news',weather:'weather',calendar:'agenda',processes:'processes',network:'network',disks:'disks',services:'services',launcher:'launcher',clipboard:'clipboard',notes:'notes',todo:'todo',bookmarks:'bookmarks',search:'search',timers:'timers',background:'background',appearance:'background',riftbreakers:'riftbreakers',geomancy:'geomancy',ai:'ai',osagent:'ai',research:'search',palette:'palette',minimize:'minimize',restore:'restore',refresh:'refresh','add-shortcut':'website','desktop-icons':'launcher','align-icons':'launcher'};
  const iconSvg = name => window.BrowserOSDesktopIcons?.svg(name||'website') || '';

  function toolAddItems(){
    return Object.entries(ShortcutManager.tools).map(([ref,v])=>({label:v.label,icon:v.icon,fn:()=>ShortcutManager.addTool(ref)}));
  }
  function actionAddItems(){
    return Object.entries(ShortcutManager.actions).map(([ref,v])=>({label:v.label,icon:v.icon,fn:()=>ShortcutManager.addAction(ref)}));
  }
  function addItems(){
    return [
      {label:'Website shortcut',icon:'website',fn:()=>ShortcutManager.addWebsite()},
      {label:'Browser-OS tool',icon:'launcher',children:toolAddItems()},
      {label:'Action',icon:'palette',children:actionAddItems()}
    ];
  }

  const desktopItems = [
    {label:'Terminal', action:'terminal'},
    {label:'System Monitor', action:'system'},
    {type:'separator'},
    {label:'Dashboard', children:[
      {label:'News', action:'news'}, {label:'Weather', action:'weather'}, {label:'Agenda', action:'calendar'},
      {label:'Network', action:'network'}, {label:'Disks', action:'disks'}, {label:'Processes', action:'processes'},
      {label:'Services', action:'services'}
    ]},
    {label:'Tools', children:[
      {label:'Search', action:'search'}, {label:'Launch app', action:'launcher'}, {label:'Clipboard', action:'clipboard'},
      {label:'Notes', action:'notes'}, {label:'Todo', action:'todo'}, {label:'Bookmarks', action:'bookmarks'},
      {label:'Timers & Reminders', action:'timers'}, {label:'Tiny Web Agent', action:'ai'}, {label:'Skills Editor', action:'skills'}, {label:'Tool Editor', action:'tooleditor'}, {label:'Scheduled Tasks', action:'cron'}, {label:'Research', action:'research'}, {label:'Riftbreakers VTT', action:'riftbreakers'}, {label:'Geomancy', action:'geomancy'}, {label:'Command palette', action:'palette'}, {label:'Background', action:'background'}, {label:'Window appearance', action:'appearance'}
    ]},
    {type:'separator'},
    {label:'Align icons to grid', action:'align-icons', icon:'launcher'},
    {label:'Add desktop icon…', action:'desktop-icons', icon:'launcher'},
    {label:'Add', icon:'launcher', children:addItems()},
    {label:'Window management', children:[
      {label:'Minimize all', action:'minimize'}, {label:'Restore all', action:'restore'}
    ]},
    {type:'separator'},
    {label:'Refresh desktop', action:'refresh'}
  ];

  let root=null;
  function close(){if(root){root.remove();root=null;}}

  function buildMenu(items,isSubmenu=false){
    const menu=document.createElement('div');
    menu.className='bos-context-menu'+(isSubmenu?' bos-context-submenu':'');
    menu.setAttribute('role','menu');
    items.forEach(item=>{
      if(item.type==='separator'){
        const sep=document.createElement('div');sep.className='bos-context-separator';menu.appendChild(sep);return;
      }
      const row=document.createElement('button');
      row.type='button';row.className='bos-context-item';row.setAttribute('role','menuitem');
      const icon=item.icon||actionIcon[item.action]||'';
      row.innerHTML=`<span class="bos-context-icon">${icon?iconSvg(icon):''}</span><span class="bos-context-label">${escapeHtml(item.label)}</span>${item.children?'<span class="bos-context-arrow">▶</span>':''}`;
      if(item.children){row.classList.add('has-submenu');row.appendChild(buildMenu(item.children,true));}
      else if(item.fn){row.addEventListener('click',e=>{e.stopPropagation();close();item.fn();});}
      else if(item.action){row.addEventListener('click',e=>{e.stopPropagation();close();actions[item.action]?.();});}
      menu.appendChild(row);
    });
    return menu;
  }

  function show(items,x,y){
    close();root=buildMenu(items);root.style.visibility='hidden';document.body.appendChild(root);
    const topbar=parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--topbar'))||32;
    const rect=root.getBoundingClientRect();
    const maxX=Math.max(4,window.innerWidth-rect.width-4),maxY=Math.max(topbar+4,window.innerHeight-rect.height-4);
    root.style.left=`${Math.min(Math.max(4,x),maxX)}px`;
    root.style.top=`${Math.min(Math.max(topbar+4,y),maxY)}px`;
    root.style.visibility='visible';
  }

  function shortcutItems(el){
    const id=el.dataset.id;
    const item=ShortcutManager.load().find(x=>x.id===id);
    if(!item)return desktopItems;
    const rows=[{label:item.type==='action'?'Run':'Open',fn:()=>ShortcutManager.activate(item)}];
    if(item.type==='website'){
      rows.push({label:'Rename',fn:()=>ShortcutManager.rename(id)});
      rows.push({label:'Change icon…',fn:()=>ShortcutManager.changeIcon(id)});
    }
    rows.push({type:'separator'});
    rows.push({label:'Remove from desktop',fn:()=>ShortcutManager.remove(id)});
    rows.push({type:'separator'});
    rows.push({label:'Add',children:addItems()});
    return rows;
  }

  function init(){
    const desktop=document.querySelector('#main-container');if(!desktop)return;
    document.addEventListener('contextmenu',e=>{
      if(e.shiftKey){close();return;}
      if(e.target.closest('#topnav, .winbox, .command-palette-overlay, input, textarea, select'))return;
      const shortcut=e.target.closest('.desktop-shortcut');
      if(!desktop.contains(e.target)&&!shortcut)return;
      e.preventDefault();e.stopPropagation();
      show(shortcut?shortcutItems(shortcut):desktopItems,e.clientX,e.clientY);
    });
    document.addEventListener('pointerdown',e=>{if(root&&!root.contains(e.target))close();},true);
    document.addEventListener('keydown',e=>{if(e.key==='Escape')close();});
    window.addEventListener('blur',close);window.addEventListener('resize',close);
  }
  function escapeHtml(v=''){return String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));}
  window.BrowserOSContextMenu={init,close,show};
})();
