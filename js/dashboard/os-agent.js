(function(){
  const TOOL_OPENERS = {
    terminal:()=>new TerminalWindow(), system:()=>new SystemWindow(), processes:()=>new ProcessesWindow(),
    network:()=>new NetworkWindow(), disks:()=>new DisksWindow(), services:()=>new ServicesWindow(),
    news:()=>new NewsWindow(), weather:()=>new WeatherWindow(), agenda:()=>new CalendarWindow(),
    clipboard:()=>new ClipboardWindow(), notes:()=>new NotesWindow(), todo:()=>new TodoWindow(),
    bookmarks:()=>new BookmarksWindow(), search:()=>new SearchWindow(), launcher:()=>new LauncherWindow(),
    timers:()=>new TimerWindow(), background:()=>new BackgroundWindow(), riftbreakers:()=>new RiftbreakersWindow(),
    chat:()=>new TinyAgentWindow()
  };
  const TITLE_MATCH = {
    terminal:['terminal'],system:['system'],processes:['process'],network:['network'],disks:['disk'],services:['service'],
    news:['news'],weather:['weather'],agenda:['agenda','outlook'],clipboard:['clipboard'],notes:['notes'],todo:['todo'],
    bookmarks:['bookmark'],search:['search'],launcher:['launch'],timers:['timer'],background:['background'],
    riftbreakers:['riftbreakers'],chat:['tiny web agent']
  };
  const getWindows=()=>Object.values(window.openWindows||{}).filter(Boolean);
  function matches(win,target){
    const hay=`${win.title||''} ${win.name||''} ${win.launcher?.name||''}`.toLowerCase();
    return (TITLE_MATCH[target]||[target]).some(x=>hay.includes(x));
  }
  function storageGet(key, fallback){try{const v=JSON.parse(localStorage.getItem(key));return v??fallback}catch{return fallback}}
  function storageSet(key,value){localStorage.setItem(key,JSON.stringify(value))}
  function refreshOpenTool(target){
    if(target==='notes') document.querySelectorAll('.notes-tool textarea').forEach(x=>x.value=storageGet('bos-notes',''));
    if(target==='todo') getWindows().filter(w=>matches(w,'todo')).forEach(w=>{}); // reopened below when requested
  }
  function execute(command){
    const action=command?.action, args=command?.args||{};
    if(action==='window'){
      const target=String(args.target||'').toLowerCase(), op=String(args.window_action||'open').toLowerCase();
      const found=getWindows().filter(w=>matches(w,target));
      if(op==='open'){ if(!found.length && TOOL_OPENERS[target]) TOOL_OPENERS[target](); else found.forEach(w=>w.minimize?.(false)); }
      else if(op==='close') found.forEach(w=>w.close?.());
      else if(op==='minimize') found.forEach(w=>w.minimize?.(true));
      else if(op==='restore') found.forEach(w=>{w.restore?.(true);w.minimize?.(false)});
      return;
    }
    if(action==='note'){
      const text=String(args.text||'').trim(); if(!text)return;
      const current=storageGet('bos-notes','');
      storageSet('bos-notes',String(args.mode||'append')==='replace'?text:(current?current+'\n'+text:text));
      refreshOpenTool('notes');
      return;
    }
    if(action==='todo'){
      const text=String(args.text||'').trim(); if(!text)return;
      const a=storageGet('bos-todos',[]);a.push({text,done:false});storageSet('bos-todos',a);
      // Recreate an already-open todo window so its private draw() state refreshes reliably.
      const found=getWindows().filter(w=>matches(w,'todo')); if(found.length){found.forEach(w=>w.close?.());setTimeout(()=>new TodoWindow(),30)}
      return;
    }
    if(action==='timer'){
      const m=String(args.duration||'').trim().match(/^(\d+(?:\.\d+)?)\s*(s|m|h)$/i); if(!m)return;
      const ms=Number(m[1])*({s:1000,m:60000,h:3600000}[m[2].toLowerCase()]);
      const a=storageGet('bos-timers',[]);a.push({at:Date.now()+ms,label:String(args.label||'Timer'),done:false});storageSet('bos-timers',a);
      return;
    }
  }
  function snapshot(){
    return {
      open_windows:getWindows().map(w=>({title:w.title||w.name||'',minimized:!!w.min})),
      location:location.origin,
      visible:!document.hidden,
      time:new Date().toISOString()
    };
  }
  async function query(prompt){
    const text=String(prompt||'').trim(); if(!text)throw new Error('Enter an OS instruction.');
    const r=await fetch('/api/os/query',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({prompt:text,state:snapshot(),skill:null})});
    const d=await r.json().catch(()=>({error:`HTTP ${r.status}`}));
    if(!r.ok)throw new Error(d.error||'OS agent request failed.');
    return d;
  }
  async function queryStream(prompt,onEvent,options={}){
    const text=String(prompt||'').trim(); if(!text)throw new Error('Enter an OS instruction.');
    const r=await fetch('/api/os/stream',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({prompt:text,state:{...snapshot(),__devmode:!!options.devmode,__devsession:options.devsession||null,__ossession:options.ossession||null,__skill:options.skill||null},devmode:!!options.devmode,devsession:options.devsession||null,ossession:options.ossession||null,skill:options.skill||null})});
    if(!r.ok || !r.body){
      const d=await r.json().catch(()=>({error:`HTTP ${r.status}`}));
      throw new Error(d.error||'OS agent request failed.');
    }
    const reader=r.body.getReader(), decoder=new TextDecoder();
    let buffer='', complete=null;
    while(true){
      const {done,value}=await reader.read();
      if(done)break;
      buffer+=decoder.decode(value,{stream:true});
      let split;
      while((split=buffer.indexOf('\n\n'))>=0){
        const block=buffer.slice(0,split); buffer=buffer.slice(split+2);
        const line=block.split('\n').find(x=>x.startsWith('data: '));
        if(!line)continue;
        let event; try{event=JSON.parse(line.slice(6))}catch{continue}
        if(event.event==='error')throw new Error(event.error||'OS agent request failed.');
        if(event.event==='complete')complete=event;
        onEvent?.(event);
      }
    }
    if(!complete)throw new Error('OS agent stream ended without a final response.');
    return complete;
  }
  function connect(){
    if(window.__browserOsAgentEvents)return;
    const es=new EventSource('/api/os/events');
    es.onmessage=e=>{try{execute(JSON.parse(e.data))}catch(err){console.error('Browser-OS agent command failed',err)}};
    es.onerror=()=>{};
    window.__browserOsAgentEvents=es;
  }
  window.BrowserOSAgent={query,queryStream,snapshot,execute,connect};
  connect();
})();
