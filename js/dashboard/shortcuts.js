/* Browser-OS desktop icon manager
 * Websites keep their own favicon; Browser-OS tools/actions use a unified monochrome SVG language.
 */
(function(){
  const KEY = 'browser-os-desktop-items-v3';
  const LEGACY_KEY = 'browser-os-shortcuts-v2';
  const QUICK_DOCK_KEY = 'browser-os-quick-launch-v1';
  const REMOVED_TOOLS_KEY = 'browser-os-desktop-removed-tools-v1';
  const selectedIds = new Set();
  let desktopSelectionInstalled = false;

  function syncSelectionClasses(){
    document.querySelectorAll('.desktop-shortcut').forEach(el=>{
      const selected = selectedIds.has(el.dataset.id);
      el.classList.toggle('selected', selected);
      el.setAttribute('aria-selected', selected ? 'true' : 'false');
    });
  }
  function clearDesktopSelection(){ selectedIds.clear(); syncSelectionClasses(); }
  function pruneSelection(items){
    const valid = new Set(items.map(item=>item.id));
    [...selectedIds].forEach(id=>{ if(!valid.has(id)) selectedIds.delete(id); });
  }

  function removedToolRefs(){
    try{
      const saved=JSON.parse(localStorage.getItem(REMOVED_TOOLS_KEY));
      return new Set(Array.isArray(saved)?saved:[]);
    }catch(_){ return new Set(); }
  }
  function saveRemovedToolRefs(refs){
    localStorage.setItem(REMOVED_TOOLS_KEY,JSON.stringify([...refs]));
  }
  function markToolRemoved(ref){
    if(!ref)return;
    const refs=removedToolRefs();refs.add(ref);saveRemovedToolRefs(refs);
  }
  function clearToolRemoved(ref){
    if(!ref)return;
    const refs=removedToolRefs();
    if(refs.delete(ref))saveRemovedToolRefs(refs);
  }


  const ICONS = {
    terminal:'<path d="M4 17l6-6-6-6"/><path d="M12 19h8"/>',
    system:'<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M8 9h8M8 13h5M8 17h8"/>',
    processes:'<path d="M4 18V9M9 18V5M14 18v-7M19 18V7"/>',
    network:'<path d="M5 12a10 10 0 0 1 14 0M8 15a6 6 0 0 1 8 0M11 18a2 2 0 0 1 2 0"/><circle cx="12" cy="20" r="1"/>',
    disks:'<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/>',
    services:'<path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8"/><circle cx="12" cy="12" r="4"/>',
    news:'<rect x="4" y="5" width="16" height="14" rx="1"/><path d="M8 9h8M8 13h8M8 17h5"/>',
    weather:'<path d="M7 17h10a4 4 0 0 0 .4-8 6 6 0 0 0-11.2 1.5A3.5 3.5 0 0 0 7 17z"/>',
    agenda:'<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M8 3v4M16 3v4M4 9h16M8 13h2M13 13h3M8 17h3"/>',
    clipboard:'<rect x="5" y="5" width="14" height="16" rx="2"/><path d="M9 5V3h6v2M8 10h8M8 14h8M8 18h5"/>',
    notes:'<path d="M5 3h11l3 3v15H5z"/><path d="M16 3v4h4M8 11h8M8 15h8M8 19h5"/>',
    todo:'<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M8 9l2 2 4-4M8 15h8"/>',
    bookmarks:'<path d="M7 4h10v17l-5-3-5 3z"/>',
    search:'<circle cx="11" cy="11" r="6"/><path d="M16 16l5 5"/>',
    launcher:'<path d="M12 3l2.5 5.5L20 11l-5.5 2.5L12 19l-2.5-5.5L4 11l5.5-2.5z"/>',
    timers:'<circle cx="12" cy="13" r="8"/><path d="M12 13V8M9 3h6M18 6l2-2"/>',
    background:'<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8" cy="9" r="2"/><path d="M4 18l5-5 3 3 2-2 6 5"/>',
    palette:'<path d="M5 6h14M5 12h14M5 18h14"/><circle cx="8" cy="6" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="10" cy="18" r="1"/>',
    minimize:'<path d="M5 19h14M7 6h10v8H7z"/>',
    restore:'<rect x="5" y="7" width="12" height="12" rx="1"/><path d="M8 7V4h11v11h-2"/>',
    refresh:'<path d="M20 6v5h-5M4 18v-5h5M18 10a7 7 0 0 0-12-3l-2 3M6 14a7 7 0 0 0 12 3l2-3"/>',
    rss:'<path d="M5 11a8 8 0 0 1 8 8M5 5a14 14 0 0 1 14 14"/><circle cx="6" cy="18" r="1.5"/>',
    riftbreakers:'<path d="M5 4h14v16H5z"/><path d="M8 8h8M8 12h3M13 12h3M8 16h8"/><path d="M3 7h2M19 7h2M3 17h2M19 17h2"/>',
    geomancy:'<circle cx="9" cy="7" r="1.2"/><circle cx="15" cy="7" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="9" cy="17" r="1.2"/><circle cx="15" cy="17" r="1.2"/><path d="M12 3v18M5 12h14"/>',
    ai:'<path d="M9 4h6M12 2v2M7 7h10a3 3 0 0 1 3 3v6a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3v-6a3 3 0 0 1 3-3Z"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><path d="M8 16h8"/>',
    skills:'<path d="M5 3h10l4 4v14H5z"/><path d="M15 3v5h5M8 12h8M8 16h6"/>',
    website:'<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18"/>'
  };

  const TOOL_REGISTRY = {
    terminal:{label:'Terminal',icon:'terminal',open:()=>new TerminalWindow()},
    system:{label:'System Monitor',icon:'system',open:()=>new SystemWindow()},
    processes:{label:'Processes',icon:'processes',open:()=>new ProcessesWindow()},
    network:{label:'Network',icon:'network',open:()=>new NetworkWindow()},
    disks:{label:'Disks',icon:'disks',open:()=>new DisksWindow()},
    services:{label:'Services',icon:'services',open:()=>new ServicesWindow()},
    news:{label:'News',icon:'news',open:()=>new NewsWindow()},
    weather:{label:'Weather',icon:'weather',open:()=>new WeatherWindow()},
    agenda:{label:'Agenda',icon:'agenda',open:()=>new CalendarWindow()},
    clipboard:{label:'Clipboard',icon:'clipboard',open:()=>new ClipboardWindow()},
    notes:{label:'Notes',icon:'notes',open:()=>new NotesWindow()},
    todo:{label:'Todo',icon:'todo',open:()=>new TodoWindow()},
    bookmarks:{label:'Bookmarks',icon:'bookmarks',open:()=>new BookmarksWindow()},
    search:{label:'Search',icon:'search',open:()=>new SearchWindow()},
    launcher:{label:'Launch app',icon:'launcher',open:()=>new LauncherWindow()},
    timers:{label:'Timers & Reminders',icon:'timers',open:()=>new TimerWindow()},
    background:{label:'Background',icon:'background',open:()=>new BackgroundWindow()},
    appearance:{label:'Window Appearance',icon:'background',open:()=>new AppearanceWindow()},
    riftbreakers:{label:'Riftbreakers VTT',icon:'riftbreakers',open:()=>new RiftbreakersWindow()},
    geomancy:{label:'Geomancy',icon:'geomancy',open:()=>new GeomancyWindow()},
    ai:{label:'Tiny Web Agent',icon:'ai',open:()=>new TinyAgentWindow()},
    skills:{label:'Skills Editor',icon:'skills',open:()=>new SkillEditorWindow()},
    tooleditor:{label:'Tool Editor',icon:'skills',open:()=>new ToolEditorWindow()},
    cron:{label:'Scheduled Tasks',icon:'timers',open:()=>new ScheduledTasksWindow()},
    research:{label:'Research',icon:'search',open:()=>new ResearchWindow()}
  };

  const ACTION_REGISTRY = {
    palette:{label:'Command palette',icon:'palette',run:()=>CommandPalette.open()},
    minimize:{label:'Minimize all',icon:'minimize',run:()=>minimizeAllWindows()},
    restore:{label:'Restore all',icon:'restore',run:()=>restoreAllWindows()},
    refresh:{label:'Refresh desktop',icon:'refresh',run:()=>location.reload()},
    'refresh-rss':{label:'Refresh RSS',icon:'rss',run:()=>new NewsWindow()}
  };

  function esc(value=''){
    return String(value).replace(/[&<>'"]/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#039;','"':'&quot;'}[ch]));
  }
  function svg(name){
    const body=ICONS[name]||ICONS.website;
    return `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.55" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
  }
  function normalizeUrl(url){
    let u=String(url||'').trim();
    if(!u)return '';
    if(!/^https?:\/\//i.test(u))u='https://'+u;
    return u;
  }
  function faviconUrl(url){
    try{
      const u=new URL(normalizeUrl(url));
      return `${u.protocol}//${u.host}/favicon.ico`;
    }catch{return ''}
  }
  function nextPosition(items){
    const cols=Math.max(1,Math.floor((window.innerWidth-24)/92));
    const n=items.length;
    return {x:24+(n%cols)*92,y:64+Math.floor(n/cols)*92};
  }

  const ShortcutManager = {
    key:KEY,
    tools:TOOL_REGISTRY,
    actions:ACTION_REGISTRY,
    defaults:[
      {id:'tool-terminal',type:'tool',ref:'terminal',name:'Terminal',x:28,y:64},
      {id:'tool-system',type:'tool',ref:'system',name:'System',x:28,y:156},
      {id:'tool-ai',type:'tool',ref:'ai',name:'Tiny Web Agent',x:28,y:248},
      {id:'tool-skills',type:'tool',ref:'skills',name:'Skills Editor',x:212,y:64},
      {id:'tool-geomancy',type:'tool',ref:'geomancy',name:'Geomancy',x:212,y:156},
      {id:'github',type:'website',name:'GitHub',url:'https://github.com',x:120,y:64},
      {id:'reddit',type:'website',name:'Reddit',url:'https://www.reddit.com',x:120,y:156},
      {id:'linguee',type:'website',name:'Linguee',url:'https://www.linguee.com',x:120,y:248}
    ],

    load(){
      try{
        const saved=JSON.parse(localStorage.getItem(KEY));
        if(Array.isArray(saved)){
          let changed=false;
          const withoutRetired=saved.filter(x=>!(x.type==='tool' && (x.ref==='webamp' || x.ref==='osagent')));
          if(withoutRetired.length!==saved.length){ saved.splice(0,saved.length,...withoutRetired); changed=true; }
          const removed=removedToolRefs();
          if(!removed.has('riftbreakers') && !saved.some(x=>x.type==='tool' && x.ref==='riftbreakers')){
            const pos=nextPosition(saved);
            saved.push({id:'tool-riftbreakers',type:'tool',ref:'riftbreakers',name:'Riftbreakers VTT',x:pos.x,y:pos.y});
            changed=true;
          }
          if(!removed.has('geomancy') && !saved.some(x=>x.type==='tool' && x.ref==='geomancy')){
            const pos=nextPosition(saved);
            saved.push({id:'tool-geomancy',type:'tool',ref:'geomancy',name:'Geomancy',x:pos.x,y:pos.y});
            changed=true;
          }
          if(!removed.has('ai') && !saved.some(x=>x.type==='tool' && x.ref==='ai')){
            const pos=nextPosition(saved);
            saved.push({id:'tool-ai',type:'tool',ref:'ai',name:'Tiny Web Agent',x:pos.x,y:pos.y});
            changed=true;
          }
          if(!removed.has('skills') && !saved.some(x=>x.type==='tool' && x.ref==='skills')){
            const pos=nextPosition(saved);
            saved.push({id:'tool-skills',type:'tool',ref:'skills',name:'Skills Editor',x:pos.x,y:pos.y});
            changed=true;
          }
          if(changed)this.save(saved);
          return saved;
        }
        const legacy=JSON.parse(localStorage.getItem(LEGACY_KEY));
        if(Array.isArray(legacy)){
          const migrated=legacy.map(x=>({...x,type:'website',iconUrl:x.iconUrl||faviconUrl(x.url)}));
          this.save(migrated);return migrated;
        }
      }catch(_){ }
      return this.defaults.map(x=>({...x}));
    },
    save(items){localStorage.setItem(KEY,JSON.stringify(items));},

    iconMarkup(item){
      if(item.type==='website'){
        const src=item.iconUrl||faviconUrl(item.url);
        const fallback=esc((item.name||'??').slice(0,2).toUpperCase());
        return `<span class="shortcut-icon website-icon"><img src="${esc(src)}" alt="" referrerpolicy="no-referrer"><span class="favicon-fallback">${fallback}</span></span>`;
      }
      const reg=item.type==='action'?ACTION_REGISTRY[item.ref]:TOOL_REGISTRY[item.ref];
      return `<span class="shortcut-icon tool-icon">${svg(reg?.icon||'website')}</span>`;
    },

    render(){
      const container=document.querySelector('#desktop-icons');
      if(!container)return;
      container.innerHTML='';
      const items=this.load();
      pruneSelection(items);
      for(const item of items){
        const el=document.createElement('button');
        el.type='button';
        el.className=`desktop-shortcut desktop-${item.type||'website'}`;
        el.dataset.id=item.id;
        el.style.left=`${item.x??28}px`;
        el.style.top=`${item.y??64}px`;
        el.innerHTML=`${this.iconMarkup(item)}<span class="shortcut-label">${esc(item.name||'Shortcut')}</span>`;
        const img=el.querySelector('.website-icon img');
        if(img){
          img.addEventListener('load',()=>el.classList.add('favicon-loaded'));
          img.addEventListener('error',()=>img.remove());
        }
        el.addEventListener('dblclick',e=>{e.preventDefault();if(el.dataset.justDragged)return;this.activate(item)});
        this.makeDraggable(el,item);
        container.appendChild(el);
      }
      syncSelectionClasses();
      installDesktopSelection();
      QuickLaunchDock.init();
    },

    activate(item){
      if(!item)return false;
      if(item.type==='website'){window.open(item.url,'_blank','noopener');return true;}
      if(item.type==='tool'){const r=TOOL_REGISTRY[item.ref];if(r){r.open();return true;}}
      if(item.type==='action'){const r=ACTION_REGISTRY[item.ref];if(r){r.run();return true;}}
      return false;
    },

    makeDraggable(el,item){
      let drag=null;

      const move=e=>{
        if(!drag || e.pointerId!==drag.pointerId)return;
        let dx=e.clientX-drag.startX,dy=e.clientY-drag.startY;
        if(!drag.moved && Math.hypot(dx,dy)<4)return;
        drag.moved=true;
        e.preventDefault();

        // Keep the whole selected group together when it reaches a desktop edge.
        dx=Math.max(drag.minDx,Math.min(drag.maxDx,dx));
        dy=Math.max(drag.minDy,Math.min(drag.maxDy,dy));
        drag.members.forEach(member=>{
          member.el.style.left=`${member.originX+dx}px`;
          member.el.style.top=`${member.originY+dy}px`;
        });
        QuickLaunchDock.updateDropTarget(e.clientX,e.clientY);
      };

      const finish=e=>{
        if(!drag || (e.pointerId!==undefined && e.pointerId!==drag.pointerId))return;
        document.removeEventListener('pointermove',move,true);
        document.removeEventListener('pointerup',finish,true);
        document.removeEventListener('pointercancel',finish,true);
        drag.members.forEach(member=>member.el.classList.remove('dragging'));

        if(drag.moved){
          el.dataset.justDragged='1';
          setTimeout(()=>delete el.dataset.justDragged,180);
          const droppedOnDock=QuickLaunchDock.isPointInside(e.clientX,e.clientY);
          if(droppedOnDock){
            // Pin copies to Quick Launch, but leave desktop icons where they started.
            drag.members.forEach(member=>{
              member.el.style.left=`${member.originX}px`;
              member.el.style.top=`${member.originY}px`;
            });
            QuickLaunchDock.addItems(drag.members.map(member=>member.item));
          }else{
            const items=this.load();
            drag.members.forEach(member=>{
              const target=items.find(saved=>saved.id===member.item.id);
              if(target){
                target.x=parseFloat(member.el.style.left)||0;
                target.y=parseFloat(member.el.style.top)||0;
              }
            });
            this.save(items);
          }
        }
        QuickLaunchDock.updateDropTarget(-9999,-9999);
        drag=null;
      };

      el.addEventListener('pointerdown',e=>{
        if(e.button!==0)return;
        e.preventDefault();
        e.stopPropagation();

        const toggle=e.ctrlKey||e.metaKey;
        const additive=e.shiftKey;
        if(toggle){
          if(selectedIds.has(item.id)){
            selectedIds.delete(item.id);
            syncSelectionClasses();
            return;
          }
          selectedIds.add(item.id);
        }else if(additive){
          selectedIds.add(item.id);
        }else if(!selectedIds.has(item.id)){
          selectedIds.clear();
          selectedIds.add(item.id);
        }
        syncSelectionClasses();

        const desktop=document.querySelector('#desktop-icons');
        const saved=this.load();
        const members=[...selectedIds].map(id=>{
          const node=desktop?.querySelector(`.desktop-shortcut[data-id="${CSS.escape(id)}"]`);
          const data=saved.find(x=>x.id===id);
          if(!node||!data)return null;
          return {
            el:node,item:data,
            originX:parseFloat(node.style.left)||0,
            originY:parseFloat(node.style.top)||0,
            width:node.offsetWidth,height:node.offsetHeight
          };
        }).filter(Boolean);
        if(!members.length)return;

        const minX=Math.min(...members.map(m=>m.originX));
        const minY=Math.min(...members.map(m=>m.originY));
        const maxRight=Math.max(...members.map(m=>m.originX+m.width));
        const maxBottom=Math.max(...members.map(m=>m.originY+m.height));
        const desktopW=desktop?.clientWidth||window.innerWidth;
        const desktopH=desktop?.clientHeight||window.innerHeight;
        drag={
          pointerId:e.pointerId,
          startX:e.clientX,startY:e.clientY,
          members,moved:false,
          minDx:-minX, maxDx:Math.max(-minX,desktopW-maxRight),
          minDy:42-minY, maxDy:Math.max(42-minY,desktopH-maxBottom)
        };
        members.forEach(member=>member.el.classList.add('dragging'));
        document.addEventListener('pointermove',move,true);
        document.addEventListener('pointerup',finish,true);
        document.addEventListener('pointercancel',finish,true);
      });
    },

    addWebsite(){
      const name=prompt('Website name:');if(!name)return;
      const url=normalizeUrl(prompt('URL:'));if(!url)return;
      const iconUrl=prompt('Icon URL (leave blank to use the website favicon):','')||faviconUrl(url);
      const items=this.load(),p=nextPosition(items);
      items.push({id:`website-${Date.now()}`,type:'website',name,url,iconUrl,x:p.x,y:p.y});
      this.save(items);this.render();
    },
    promptAdd(){this.addWebsite();},
    alignToGrid(){
      const items=this.load();
      if(!items.length)return;
      const desktop=document.querySelector('#main-container')||document.documentElement;
      const height=Math.max(240,desktop.clientHeight||window.innerHeight);
      const startX=28,startY=64,stepX=92,stepY=92;
      // Leave breathing room for the quick-launch dock / minimized-window strip.
      const usableBottom=Math.max(startY+stepY,height-100);
      const rows=Math.max(1,Math.floor((usableBottom-startY)/stepY)+1);

      // Preserve the user's current spatial reading order: left column top-to-bottom,
      // then proceed to the next column. Stable fallback is the saved item order.
      const ordered=items.map((item,index)=>({item,index})).sort((a,b)=>{
        const ax=Number(a.item.x??startX),bx=Number(b.item.x??startX);
        if(Math.abs(ax-bx)>stepX/2)return ax-bx;
        const ay=Number(a.item.y??startY),by=Number(b.item.y??startY);
        return ay-by || a.index-b.index;
      });

      ordered.forEach(({item},index)=>{
        const col=Math.floor(index/rows),row=index%rows;
        item.x=startX+col*stepX;
        item.y=startY+row*stepY;
      });
      this.save(items);
      clearDesktopSelection();
      this.render();
    },

    addTool(ref){
      const r=TOOL_REGISTRY[ref];if(!r)return;
      clearToolRemoved(ref);
      const items=this.load();
      if(items.some(x=>x.type==='tool'&&x.ref===ref))return;
      const p=nextPosition(items);
      items.push({id:`tool-${ref}`,type:'tool',ref,name:r.label,x:p.x,y:p.y});
      this.save(items);this.render();
    },
    addAction(ref){
      const r=ACTION_REGISTRY[ref];if(!r)return;
      const items=this.load();
      if(items.some(x=>x.type==='action'&&x.ref===ref))return;
      const p=nextPosition(items);
      items.push({id:`action-${ref}`,type:'action',ref,name:r.label,x:p.x,y:p.y});
      this.save(items);this.render();
    },
    remove(id){
      const items=this.load();
      const item=items.find(entry=>entry.id===id);
      if(item?.type==='tool')markToolRemoved(item.ref);
      selectedIds.delete(id);
      this.save(items.filter(entry=>entry.id!==id));
      this.render();
    },
    rename(id){
      const items=this.load(),item=items.find(x=>x.id===id);if(!item)return;
      const name=prompt('Name:',item.name);if(!name)return;
      item.name=name.trim();this.save(items);this.render();
    },
    changeIcon(id){
      const items=this.load(),item=items.find(x=>x.id===id);if(!item||item.type!=='website')return;
      const value=prompt('Icon URL (leave blank to reset to website favicon):',item.iconUrl||'');
      if(value===null)return;
      item.iconUrl=value.trim()||faviconUrl(item.url);this.save(items);this.render();
    },
    openManager(){
      const host=document.createElement('section');
      host.className='tool desktop-icon-manager';
      host.innerHTML=`<header class="tool-head"><span>Add desktop icon</span><small>Tools remain available even when their desktop icon is removed.</small></header>
        <div class="desktop-icon-manager-section"><h3>Browser-OS tools</h3><div class="desktop-icon-manager-grid" data-icon-tools></div></div>
        <div class="desktop-icon-manager-section"><h3>Actions</h3><div class="desktop-icon-manager-grid" data-icon-actions></div></div>
        <div class="desktop-icon-manager-section"><h3>Website</h3><button type="button" class="desktop-icon-add-website">${svg('website')}<span>Add website shortcut…</span></button></div>`;

      const renderRows=()=>{
        const existing=this.load();
        const fill=(selector,registry,type)=>{
          const box=host.querySelector(selector);box.innerHTML='';
          Object.entries(registry).forEach(([ref,r])=>{
            const present=existing.some(x=>x.type===type&&x.ref===ref);
            const row=document.createElement('button');row.type='button';row.className='desktop-icon-choice'+(present?' present':'');
            row.innerHTML=`<span class="menu-svg">${svg(r.icon||'website')}</span><span class="desktop-icon-choice-name">${esc(r.label)}</span><span class="desktop-icon-choice-action">${present?'Remove':'Add'}</span>`;
            row.addEventListener('click',()=>{
              if(present){const found=this.load().find(x=>x.type===type&&x.ref===ref);if(found)this.remove(found.id);}
              else if(type==='tool')this.addTool(ref);else this.addAction(ref);
              renderRows();
            });
            box.appendChild(row);
          });
        };
        fill('[data-icon-tools]',TOOL_REGISTRY,'tool');
        fill('[data-icon-actions]',ACTION_REGISTRY,'action');
      };
      host.querySelector('.desktop-icon-add-website').addEventListener('click',()=>this.addWebsite());
      renderRows();
      return new ApplicationWindow({title:'Desktop icons',label:'Desktop icons',width:540,height:560,mount:host,launcher:{name:'DesktopIconManagerWindow',opts:{}},onclose:()=>host.remove()});
    },
    reset(){localStorage.removeItem(KEY);this.render();},
    open(name){
      const q=String(name||'').toLowerCase();
      const found=this.load().find(i=>(i.name||'').toLowerCase()===q||i.id.toLowerCase()===q);
      return this.activate(found);
    }
  };

  function installDesktopSelection(){
    if(desktopSelectionInstalled)return;
    const main=document.querySelector('#main-container');
    if(!main)return;
    desktopSelectionInstalled=true;

    main.addEventListener('pointerdown',event=>{
      if(event.button!==0)return;
      if(event.target.closest('.desktop-shortcut,.winbox,#right-dock,#browseros-quick-launch,input,textarea,select,button,a'))return;
      const rect=main.getBoundingClientRect();
      const startX=event.clientX,startY=event.clientY;
      let moved=false;
      let box=null;
      const additive=event.ctrlKey||event.metaKey||event.shiftKey;
      const startingSelection=new Set(selectedIds);

      const updateSelection=(x1,y1,x2,y2)=>{
        const left=Math.min(x1,x2),right=Math.max(x1,x2),top=Math.min(y1,y2),bottom=Math.max(y1,y2);
        if(!additive)selectedIds.clear();
        else{ selectedIds.clear(); startingSelection.forEach(id=>selectedIds.add(id)); }
        document.querySelectorAll('.desktop-shortcut').forEach(icon=>{
          const r=icon.getBoundingClientRect();
          const hit=!(r.right<left||r.left>right||r.bottom<top||r.top>bottom);
          if(hit)selectedIds.add(icon.dataset.id);
        });
        syncSelectionClasses();
      };

      const move=e=>{
        if(Math.hypot(e.clientX-startX,e.clientY-startY)<4 && !moved)return;
        moved=true;
        if(!box){
          box=document.createElement('div');
          box.className='desktop-selection-box';
          main.appendChild(box);
        }
        const x=Math.min(startX,e.clientX)-rect.left;
        const y=Math.min(startY,e.clientY)-rect.top;
        const w=Math.abs(e.clientX-startX),h=Math.abs(e.clientY-startY);
        Object.assign(box.style,{left:`${x}px`,top:`${y}px`,width:`${w}px`,height:`${h}px`});
        updateSelection(startX,startY,e.clientX,e.clientY);
      };
      const finish=e=>{
        document.removeEventListener('pointermove',move,true);
        document.removeEventListener('pointerup',finish,true);
        document.removeEventListener('pointercancel',finish,true);
        box?.remove();
        if(!moved && !additive)clearDesktopSelection();
      };
      document.addEventListener('pointermove',move,true);
      document.addEventListener('pointerup',finish,true);
      document.addEventListener('pointercancel',finish,true);
    });

    window.addEventListener('keydown',event=>{
      if(event.key==='Escape' && selectedIds.size)clearDesktopSelection();
    });
  }

  const QuickLaunchDock = {
    root:null,
    bar:null,
    observer:null,
    dragIndex:null,
    suppressClick:false,
    hideTimer:null,
    edgeListener:null,
    visible:false,

    load(){
      try{
        const items=JSON.parse(localStorage.getItem(QUICK_DOCK_KEY)||'[]');
        return Array.isArray(items)?items:[];
      }catch(_){return []}
    },
    save(items){localStorage.setItem(QUICK_DOCK_KEY,JSON.stringify(items));},
    identity(item){
      if(item.type==='tool'||item.type==='action')return `${item.type}:${item.ref}`;
      if(item.type==='website')return `website:${String(item.url||'').toLowerCase()}`;
      return String(item.id||item.name||'');
    },
    cloneItem(item){
      return {
        id:`quick-${Date.now()}-${Math.random().toString(36).slice(2,8)}`,
        sourceId:item.id||'',type:item.type||'website',ref:item.ref||'',
        name:item.name||'Shortcut',url:item.url||'',iconUrl:item.iconUrl||''
      };
    },
    init(){
      if(this.root&&document.body.contains(this.root)){this.render();return;}
      this.root=document.createElement('div');
      this.root.id='browseros-quick-launch';
      this.root.setAttribute('aria-label','Quick Launch');
      this.root.setAttribute('aria-hidden','true');
      this.root.innerHTML='<div class="quick-launch-bar" role="toolbar" aria-label="Quick Launch"></div>';
      document.body.appendChild(this.root);
      this.bar=this.root.querySelector('.quick-launch-bar');

      // Keep the dock open while the pointer is actually over it.
      this.root.addEventListener('pointerenter',()=>this.show());
      this.root.addEventListener('pointerleave',()=>this.scheduleHide());

      // Bottom-edge activation uses pointer position instead of an overlay element,
      // so the hot zone never steals clicks from WinBox's minimized-window strip.
      this.edgeListener=event=>{
        const edge=Math.max(3,Math.min(8,Math.round(window.innerHeight*.006)));
        if(event.clientY>=window.innerHeight-edge){
          this.show();
        }else if(this.visible && !this.isPointInside(event.clientX,event.clientY) && !this.root.matches(':hover')){
          this.scheduleHide();
        }
      };
      document.addEventListener('pointermove',this.edgeListener,{passive:true});

      this.render();
      this.updateMinimizedOffset();
      this.observer=new MutationObserver(()=>this.updateMinimizedOffset());
      this.observer.observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['class']});
    },
    show(){
      if(!this.root)return;
      clearTimeout(this.hideTimer);
      this.hideTimer=null;
      this.visible=true;
      this.root.classList.add('dock-visible');
      this.root.setAttribute('aria-hidden','false');
    },
    hide(){
      if(!this.root)return;
      clearTimeout(this.hideTimer);
      this.hideTimer=null;
      this.visible=false;
      this.root.classList.remove('dock-visible');
      this.root.setAttribute('aria-hidden','true');
      this.root.classList.remove('drop-active');
    },
    scheduleHide(delay=650){
      clearTimeout(this.hideTimer);
      this.hideTimer=setTimeout(()=>{
        if(this.root?.matches(':hover'))return;
        this.hide();
      },delay);
    },
    render(){
      if(!this.bar)return;
      const items=this.load();
      this.bar.innerHTML='';
      if(!items.length){
        const hint=document.createElement('div');
        hint.className='quick-launch-empty';
        hint.textContent='Drag desktop icons here';
        this.bar.appendChild(hint);
      }
      items.forEach((item,index)=>{
        const button=document.createElement('button');
        button.type='button';
        button.className='quick-launch-item';
        button.draggable=true;
        button.dataset.index=String(index);
        button.title=`${item.name} — right-click to remove`;
        button.setAttribute('aria-label',item.name);
        button.innerHTML=ShortcutManager.iconMarkup(item);
        const img=button.querySelector('.website-icon img');
        if(img){
          img.addEventListener('load',()=>button.classList.add('favicon-loaded'));
          img.addEventListener('error',()=>img.remove());
        }
        button.addEventListener('click',()=>{
          if(this.suppressClick){this.suppressClick=false;return;}
          ShortcutManager.activate(item);
          this.scheduleHide(450);
        });
        button.addEventListener('contextmenu',event=>{
          event.preventDefault();event.stopPropagation();
          const next=this.load();next.splice(index,1);this.save(next);this.render();
        });
        button.addEventListener('dragstart',event=>{
          this.dragIndex=index;
          button.classList.add('dock-dragging');
          event.dataTransfer.effectAllowed='move';
          try{event.dataTransfer.setData('text/plain',String(index));}catch(_){}
        });
        button.addEventListener('dragend',()=>{this.dragIndex=null;button.classList.remove('dock-dragging');this.suppressClick=true;});
        button.addEventListener('dragover',event=>{event.preventDefault();event.dataTransfer.dropEffect='move';button.classList.add('dock-drop-before');});
        button.addEventListener('dragleave',()=>button.classList.remove('dock-drop-before'));
        button.addEventListener('drop',event=>{
          event.preventDefault();button.classList.remove('dock-drop-before');
          const from=this.dragIndex;
          if(from===null||from===index)return;
          const next=this.load();
          const [moved]=next.splice(from,1);
          const target=from<index?index-1:index;
          next.splice(target,0,moved);this.save(next);this.render();
          this.dragIndex=null;
        });
        this.bar.appendChild(button);
      });
    },
    addItems(items){
      const next=this.load();
      const existing=new Set(next.map(item=>this.identity(item)));
      items.forEach(item=>{
        const key=this.identity(item);
        if(!key||existing.has(key))return;
        next.push(this.cloneItem(item));existing.add(key);
      });
      this.save(next);this.render();
      this.show();
      this.root?.classList.add('quick-launch-added');
      setTimeout(()=>this.root?.classList.remove('quick-launch-added'),450);
      this.scheduleHide(1100);
    },
    isPointInside(x,y){
      if(!this.bar)return false;
      const r=this.bar.getBoundingClientRect();
      return x>=r.left&&x<=r.right&&y>=r.top&&y<=r.bottom;
    },
    updateDropTarget(x,y){
      if(!this.root)return;
      const nearBottom=Number.isFinite(y) && y>=window.innerHeight-72;
      if(nearBottom)this.show();
      const inside=this.isPointInside(x,y);
      this.root.classList.toggle('drop-active',inside);
      if(!nearBottom && !inside && x<-1000 && y<-1000)this.scheduleHide(500);
    },
    updateMinimizedOffset(){
      if(!this.root)return;
      const hasMinimized=!!document.querySelector('.winbox.min');
      this.root.classList.toggle('above-minimized',hasMinimized);
    }
  };

  window.BrowserOSQuickLaunchDock=QuickLaunchDock;
  window.clearDesktopSelection=clearDesktopSelection;
  window.ShortcutManager=ShortcutManager;
  window.BrowserOSDesktopIcons={svg,tools:TOOL_REGISTRY,actions:ACTION_REGISTRY};
  window.DesktopIconManagerWindow=function(){return ShortcutManager.openManager();};
})();
