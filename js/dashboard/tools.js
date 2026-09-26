(function(){
const S={get(k,d){try{const v=JSON.parse(localStorage.getItem(k));return v??d}catch{return d}},set(k,v){localStorage.setItem(k,JSON.stringify(v))}};
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
function mount(template){const n=document.querySelector(template).content.firstElementChild.cloneNode(true);document.querySelector('#window-mounts').appendChild(n);return n}
function win(title,node,opts,name,defaults={}){return new ApplicationWindow({title,label:`${name}-${Date.now()}`,x:opts.x,y:opts.y,width:opts.width||defaults.width||'520',height:opts.height||defaults.height||'440',launcher:{name,opts:{...opts}},mount:node,onclose:()=>node.remove()})}

class NotesWindow{constructor(opts={}){const n=mount('#notes-template'),ta=n.querySelector('textarea'),s=n.querySelector('.save-state');ta.value=S.get('bos-notes','');let t;ta.oninput=()=>{s.textContent='editing';clearTimeout(t);t=setTimeout(()=>{S.set('bos-notes',ta.value);s.textContent='saved'},350)};this.window=win('Notes',n,opts,'NotesWindow',{width:'520',height:'430'})}}

class TodoWindow{constructor(opts={}){const n=mount('#todo-template'),input=n.querySelector('input'),list=n.querySelector('.todo-list');const key='bos-todos';const draw=()=>{const a=S.get(key,[]);list.innerHTML=a.map((x,i)=>`<label class="todo-row"><input type="checkbox" data-i="${i}" ${x.done?'checked':''}><span class="${x.done?'done':''}">${esc(x.text)}</span><button data-del="${i}">×</button></label>`).join('')||'<div class="empty">No tasks.</div>';list.querySelectorAll('[data-i]').forEach(e=>e.onchange=()=>{a[+e.dataset.i].done=e.checked;S.set(key,a);draw()});list.querySelectorAll('[data-del]').forEach(e=>e.onclick=()=>{a.splice(+e.dataset.del,1);S.set(key,a);draw()})};n.querySelector('.todo-add').onclick=()=>{if(!input.value.trim())return;const a=S.get(key,[]);a.push({text:input.value.trim(),done:false});S.set(key,a);input.value='';draw()};input.onkeydown=e=>{if(e.key==='Enter')n.querySelector('.todo-add').click()};draw();this.window=win('Todo',n,opts,'TodoWindow',{width:'430',height:'470'})}}

class ClipboardWindow{constructor(opts={}){const n=mount('#clipboard-template'),list=n.querySelector('.clipboard-list'),key='bos-clipboard';const draw=()=>{const a=S.get(key,[]);list.innerHTML=a.map((x,i)=>`<button class="clip-row" data-i="${i}">${esc(x)}</button>`).join('')||'<div class="empty">Clipboard history is empty.</div>';list.querySelectorAll('[data-i]').forEach(e=>e.onclick=async()=>navigator.clipboard.writeText(a[+e.dataset.i]))};n.querySelector('.clipboard-capture').onclick=async()=>{try{const text=await navigator.clipboard.readText();if(text){let a=S.get(key,[]).filter(x=>x!==text);a.unshift(text);a=a.slice(0,30);S.set(key,a);draw()}}catch(e){alert('Clipboard read permission was denied. Use this button after granting clipboard access to localhost.')}};n.querySelector('.clipboard-clear').onclick=()=>{S.set(key,[]);draw()};draw();this.window=win('Clipboard',n,opts,'ClipboardWindow',{width:'470',height:'470'})}}

class BookmarksWindow{constructor(opts={}){const n=mount('#bookmarks-template'),list=n.querySelector('.bookmark-list'),status=n.querySelector('.bookmark-status'),key='bos-bookmarks';let source='local',chrome=[];
const setSource=v=>{source=v;n.querySelector('.bookmark-source-local').classList.toggle('active',v==='local');n.querySelector('.bookmark-source-chrome').classList.toggle('active',v==='chrome');n.querySelector('.bookmark-add').style.display=v==='local'?'':'none';draw()};
const bookmarkRow=(x,i,local=false)=>`<div class="bookmark-row"><button data-open="${i}"><b>${esc(x.name)}</b><small>${esc(x.url)}</small></button>${local?`<button data-del="${i}">×</button>`:''}</div>`;
const folderTree=items=>{const root={folders:new Map(),items:[]};items.forEach((x,i)=>{let node=root;const parts=String(x.folder||'Unfiled').split(' / ').map(v=>v.trim()).filter(Boolean);for(const part of parts){if(!node.folders.has(part))node.folders.set(part,{folders:new Map(),items:[]});node=node.folders.get(part)}node.items.push({x,i})});return root};
const renderNode=(node,depth=0)=>{let html='';for(const [name,child] of node.folders){const count=(function total(n){let c=n.items.length;for(const v of n.folders.values())c+=total(v);return c})(child);html+=`<details class="bookmark-folder" ${depth===0?'open':''}><summary><span class="bookmark-folder-icon">▸</span><b>${esc(name)}</b><small>${count}</small></summary><div class="bookmark-folder-contents">${child.items.map(({x,i})=>bookmarkRow(x,i,false)).join('')}${renderNode(child,depth+1)}</div></details>`}if(depth===0&&node.items.length)html+=`<details class="bookmark-folder" open><summary><span class="bookmark-folder-icon">▸</span><b>Unfiled</b><small>${node.items.length}</small></summary><div class="bookmark-folder-contents">${node.items.map(({x,i})=>bookmarkRow(x,i,false)).join('')}</div></details>`;return html};
const draw=()=>{const a=source==='local'?S.get(key,[]):chrome;status.textContent=source==='chrome'?(chrome.length?`${chrome.length} Chrome bookmarks · grouped by folder · read-only sync`:'Chrome bookmarks not loaded'):`${a.length} Browser-OS bookmark${a.length===1?'':'s'}`;if(source==='chrome')list.innerHTML=chrome.length?renderNode(folderTree(chrome)):'<div class="empty">No bookmarks.</div>';else list.innerHTML=a.map((x,i)=>bookmarkRow(x,i,true)).join('')||'<div class="empty">No bookmarks.</div>';list.querySelectorAll('[data-open]').forEach(e=>e.onclick=()=>window.open(a[+e.dataset.open].url,'_blank','noopener'));if(source==='local')list.querySelectorAll('[data-del]').forEach(e=>e.onclick=()=>{a.splice(+e.dataset.del,1);S.set(key,a);draw()})};
const loadChrome=async()=>{status.textContent='Reading Chrome bookmarks…';try{const d=await fetch('/api/chrome-bookmarks',{cache:'no-store'}).then(r=>r.json());chrome=d.bookmarks||[];status.textContent=d.available?`${chrome.length} Chrome bookmarks from ${d.profiles.length} profile(s)`:d.error||'Chrome bookmarks unavailable';if(source==='chrome')draw()}catch(e){status.textContent=e.message}};
n.querySelector('.bookmark-source-local').onclick=()=>setSource('local');n.querySelector('.bookmark-source-chrome').onclick=async()=>{setSource('chrome');await loadChrome()};n.querySelector('.bookmark-refresh').onclick=loadChrome;n.querySelector('.bookmark-add').onclick=()=>{const name=prompt('Bookmark name:');if(!name)return;let url=prompt('URL:');if(!url)return;if(!/^https?:\/\//i.test(url))url='https://'+url;const a=S.get(key,[]);a.push({name,url});S.set(key,a);draw()};draw();this.window=win('Bookmarks',n,opts,'BookmarksWindow',{width:'620',height:'520'})}}

const engines={google:q=>`https://www.google.com/search?q=${encodeURIComponent(q)}`,github:q=>`https://github.com/search?q=${encodeURIComponent(q)}`,wikipedia:q=>`https://en.wikipedia.org/w/index.php?search=${encodeURIComponent(q)}`,youtube:q=>`https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`,reddit:q=>`https://www.reddit.com/search/?q=${encodeURIComponent(q)}`};
class SearchWindow{constructor(opts={}){const n=mount('#search-template'),i=n.querySelector('input'),sel=n.querySelector('select');const go=()=>{if(i.value.trim())window.open(engines[sel.value](i.value.trim()),'_blank','noopener')};n.querySelector('.search-go').onclick=go;i.onkeydown=e=>{if(e.key==='Enter')go()};this.window=win('Search',n,opts,'SearchWindow',{width:'500',height:'170'});setTimeout(()=>i.focus(),50)}}

class LauncherWindow{
  constructor(opts={}){
    const n=mount('#launcher-template'), list=n.querySelector('.launcher-list'), search=n.querySelector('.launcher-search'), status=n.querySelector('.launcher-status'), refresh=n.querySelector('.launcher-refresh');
    let apps=[];
    const draw=()=>{
      const q=search.value.trim().toLowerCase();
      const filtered=!q?apps:apps.filter(a=>(a.name+' '+(a.command||'')).toLowerCase().includes(q));
      status.textContent=`${filtered.length}${q?' / '+apps.length:''} apps`;
      list.innerHTML=filtered.map((x,i)=>`<button class="launcher-app" data-index="${i}" title="Launch ${esc(x.name)}"><span class="launcher-app-icon">${esc((x.name||'?').trim().charAt(0).toUpperCase())}</span><span class="launcher-app-copy"><b>${esc(x.name)}</b><small>${x.source==='configured'?esc(x.command||'Configured app'):'Windows app'}</small></span><span class="launcher-app-open">↗</span></button>`).join('')||'<div class="empty">No matching applications.</div>';
      list.querySelectorAll('[data-index]').forEach(b=>b.onclick=()=>launch(filtered[+b.dataset.index]));
      return filtered;
    };
    const launch=async app=>{
      if(!app)return;
      status.textContent=`Launching ${app.name}…`;
      try{
        const r=await fetch('/api/apps/launch',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({source:app.source,id:app.id})});
        const d=await r.json();
        if(!r.ok)throw new Error(d.error||'Launch failed');
        status.textContent=`Launched ${app.name}`;
      }catch(e){status.textContent=e.message;alert(e.message)}
    };
    const load=async force=>{
      status.textContent='Discovering Windows apps…'; list.innerHTML='<div class="empty">Reading Start menu applications…</div>';
      try{
        const d=await fetch('/api/apps'+(force?'?refresh=1':''),{cache:'no-store'}).then(async r=>{const x=await r.json();if(!r.ok)throw new Error(x.error||'Could not load apps');return x});
        apps=Array.isArray(d)?d:(d.apps||[]); draw();
      }catch(e){list.innerHTML=`<div class="empty">${esc(e.message)}</div>`;status.textContent='Unavailable'}
    };
    search.oninput=draw;
    search.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();const f=draw();if(f.length)launch(f[0])}};
    refresh.onclick=()=>load(true);
    load(false);
    this.window=win('Applications',n,opts,'LauncherWindow',{width:'560',height:'560'});
    setTimeout(()=>search.focus(),60);
  }
}

class NetworkWindow{constructor(opts={}){const n=mount('#network-template'),out=n.querySelector('.network-data');const load=async()=>{const d=await fetch('/api/network',{cache:'no-store'}).then(r=>r.json());out.innerHTML=`<div class="kv"><span>Interface</span><b>${esc(d.interface||'—')}</b><span>IPv4</span><b>${esc(d.ip4||'—')}</b><span>IPv6</span><b>${esc(d.ip6||'—')}</b><span>Download</span><b>${fmtRate(d.rxSec)}</b><span>Upload</span><b>${fmtRate(d.txSec)}</b><span>Received</span><b>${fmtBytes(d.rxBytes)}</b><span>Sent</span><b>${fmtBytes(d.txBytes)}</b></div>`};load();const t=setInterval(load,1500);this.window=new ApplicationWindow({title:'Network',label:`network-${Date.now()}`,x:opts.x,y:opts.y,width:opts.width||'460',height:opts.height||'330',launcher:{name:'NetworkWindow',opts:{...opts}},mount:n,onclose:()=>{clearInterval(t);n.remove()}})}}

class DisksWindow{constructor(opts={}){const n=mount('#disks-template'),list=n.querySelector('.disk-list');const load=async()=>{const a=await fetch('/api/disks',{cache:'no-store'}).then(r=>r.json());list.innerHTML=a.map(d=>`<div class="disk-row"><div><b>${esc(d.fs||d.mount)}</b><small>${esc(d.mount||'')}</small></div><strong>${Math.round(d.use||0)}%</strong><div class="meter"><i style="width:${Math.min(100,d.use||0)}%"></i></div><small>${fmtBytes(d.used)} / ${fmtBytes(d.size)}</small></div>`).join('')};load();this.window=win('Disks',n,opts,'DisksWindow',{width:'520',height:'430'})}}

class ProcessesWindow{constructor(opts={}){const n=mount('#processes-template'),list=n.querySelector('.process-list');let sort='cpu';const buttons=[...n.querySelectorAll('[data-sort]')];const load=async()=>{const a=await fetch('/api/processes?sort='+sort,{cache:'no-store'}).then(r=>r.json());list.innerHTML=`<div class="process-row head"><span>Process</span><span>CPU</span><span>RAM</span></div>`+a.map(p=>`<div class="process-row"><span title="${esc(p.name)}">${esc(p.name)}</span><span>${Number(p.cpu||0).toFixed(1)}%</span><span>${Number(p.mem||0).toFixed(1)}%</span></div>`).join('')};buttons.forEach(b=>b.onclick=()=>{sort=b.dataset.sort;buttons.forEach(x=>x.classList.toggle('active',x===b));load()});load();const t=setInterval(load,3000);this.window=new ApplicationWindow({title:'Processes',label:`processes-${Date.now()}`,x:opts.x,y:opts.y,width:opts.width||'520',height:opts.height||'500',launcher:{name:'ProcessesWindow',opts:{...opts}},mount:n,onclose:()=>{clearInterval(t);n.remove()}})}}

class ServicesWindow{constructor(opts={}){const n=mount('#services-template'),list=n.querySelector('.service-list');const load=async()=>{const a=await fetch('/api/services',{cache:'no-store'}).then(r=>r.json());list.innerHTML=a.map(s=>`<div class="service-row"><i class="dot ${s.online?'online':''}"></i><b>${esc(s.name)}</b><span>${esc(s.host)}:${s.port}</span><strong>${s.online?'ONLINE':'OFFLINE'}</strong></div>`).join('')};load();const t=setInterval(load,5000);this.window=new ApplicationWindow({title:'Services',label:`services-${Date.now()}`,x:opts.x,y:opts.y,width:opts.width||'540',height:opts.height||'400',launcher:{name:'ServicesWindow',opts:{...opts}},mount:n,onclose:()=>{clearInterval(t);n.remove()}})}}

class WeatherWindow{constructor(opts={}){const n=mount('#weather-template'),q=n.querySelector('input'),out=n.querySelector('.weather-out');q.value=S.get('bos-weather-city','Toronto');const load=async()=>{if(!q.value.trim())return;S.set('bos-weather-city',q.value.trim());out.textContent='Loading…';const d=await fetch('/api/weather?city='+encodeURIComponent(q.value.trim()),{cache:'no-store'}).then(r=>r.json());if(d.error){out.textContent=d.error;return}out.innerHTML=`<div class="weather-now"><strong>${Math.round(d.current.temperature_2m)}°C</strong><div><b>${esc(d.location.name)}</b><small>Feels ${Math.round(d.current.apparent_temperature)}°C · wind ${Math.round(d.current.wind_speed_10m)} km/h</small></div></div><div class="forecast">${d.daily.time.slice(0,5).map((x,i)=>`<div><span>${new Date(x+'T12:00').toLocaleDateString([],{weekday:'short'})}</span><b>${Math.round(d.daily.temperature_2m_max[i])}°</b><small>${Math.round(d.daily.temperature_2m_min[i])}°</small></div>`).join('')}</div>`};n.querySelector('.weather-go').onclick=load;q.onkeydown=e=>{if(e.key==='Enter')load()};load();this.window=win('Weather',n,opts,'WeatherWindow',{width:'500',height:'350'})}}

const AlarmService=(()=>{
  const key='bos-timers',listeners=new Set();let audioCtx=null;
  const items=()=>{const raw=S.get(key,[]);let changed=false;const a=raw.map((x,i)=>{if(x.id)return {...x,type:x.type||'timer'};changed=true;return {...x,type:x.type||'timer',id:`legacy-${Number(x.at)||0}-${i}`}});if(changed)S.set(key,a);return a};
  const save=a=>{S.set(key,a);for(const fn of listeners)try{fn(a)}catch(_){}};
  const unlock=()=>{try{audioCtx=audioCtx||new (window.AudioContext||window.webkitAudioContext)();if(audioCtx.state==='suspended')audioCtx.resume()}catch(_){}};
  const activeRings=new Map();
  const sound=()=>{try{unlock();if(!audioCtx||audioCtx.state!=='running')return;const t=audioCtx.currentTime;[0,.22,.44,.78,1.0].forEach((delay,i)=>{const o=audioCtx.createOscillator(),g=audioCtx.createGain();o.type=i%2?'sine':'square';o.frequency.setValueAtTime(i%2?880:660,t+delay);g.gain.setValueAtTime(.0001,t+delay);g.gain.exponentialRampToValueAtTime(5.0,t+delay+.015);g.gain.exponentialRampToValueAtTime(.0001,t+delay+.18);o.connect(g).connect(audioCtx.destination);o.start(t+delay);o.stop(t+delay+.2)})}catch(_){}};
  const stopRing=id=>{const timer=activeRings.get(id);if(timer){clearInterval(timer);activeRings.delete(id)}};
  const startRing=x=>{stopRing(x.id);sound();activeRings.set(x.id,setInterval(sound,2200))};
  const toast=x=>{const prev=document.querySelector('.bos-alarm-toast');if(prev){stopRing(prev.dataset.alarmId);prev.remove()}const d=document.createElement('div');d.dataset.alarmId=x.id;d.className='bos-alarm-toast';d.innerHTML=`<strong>${esc(x.type==='reminder'?'Reminder':'Timer')}</strong><span>${esc(x.label||(x.type==='reminder'?'Reminder':'Timer finished'))}</span><button type="button">Dismiss alarm</button>`;document.body.appendChild(d);d.querySelector('button').onclick=()=>{stopRing(x.id);d.remove()}};
  const fire=x=>{startRing(x);toast(x);try{if(Notification.permission==='granted')new Notification(x.type==='reminder'?'Browser-OS reminder':'Browser-OS timer',{body:x.label||(x.type==='reminder'?'Reminder':'Timer finished'),requireInteraction:true})}catch(_){}};
  const check=()=>{const a=items(),now=Date.now();let changed=false;for(const x of a){if(!x.done&&Number(x.at)<=now){x.done=true;x.firedAt=now;changed=true;fire(x)}}if(changed)save(a)};
  const add=x=>{unlock();if(Notification.permission==='default')Notification.requestPermission().catch(()=>{});const a=items();a.push({id:`alarm-${Date.now()}-${Math.random().toString(36).slice(2,6)}`,done:false,...x});save(a);check()};
  const remove=id=>save(items().filter(x=>x.id!==id));
  const subscribe=fn=>{listeners.add(fn);fn(items());return()=>listeners.delete(fn)};
  document.addEventListener('pointerdown',unlock,{once:true,capture:true});document.addEventListener('keydown',unlock,{once:true,capture:true});
  setInterval(check,500);setTimeout(check,250);
  return{items,add,remove,check,subscribe,unlock};
})();

class TimerWindow{
  constructor(opts={}){
    const n=mount('#timer-template'),list=n.querySelector('.timer-list'),duration=n.querySelector('.timer-duration'),timerLabel=n.querySelector('.timer-label'),reminderLabel=n.querySelector('.reminder-label'),reminderAt=n.querySelector('.reminder-at');const pad=v=>String(v).padStart(2,'0'),next=new Date(Date.now()+3600000);next.setMinutes(0,0,0);reminderAt.value=`${next.getFullYear()}-${pad(next.getMonth()+1)}-${pad(next.getDate())}T${pad(next.getHours())}:${pad(next.getMinutes())}`;
    const parse=v=>{const m=String(v).trim().match(/^(\d+(?:\.\d+)?)\s*(s|m|h|d)$/i);if(!m)return null;return Number(m[1])*({s:1000,m:60000,h:3600000,d:86400000}[m[2].toLowerCase()])};
    const fmtWhen=at=>new Date(at).toLocaleString([], {month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});
    const draw=a=>{const now=Date.now();a=[...a].sort((x,y)=>(x.done-y.done)||(x.at-y.at));list.innerHTML=a.map(x=>`<div class="timer-row ${x.done?'alarm-done':''}"><span class="alarm-kind">${x.type==='reminder'?'REMINDER':'TIMER'}</span><b>${esc(x.label||(x.type==='reminder'?'Reminder':'Timer'))}</b><small>${x.done?'triggered '+fmtWhen(x.at):(x.type==='reminder'?fmtWhen(x.at):formatRemain(x.at-now))}</small><button data-del="${esc(x.id)}" title="Delete">×</button></div>`).join('')||'<div class="empty">No timers or reminders.</div>';list.querySelectorAll('[data-del]').forEach(b=>b.onclick=()=>AlarmService.remove(b.dataset.del))};
    const unsub=AlarmService.subscribe(draw);let repaint=setInterval(()=>draw(AlarmService.items()),1000);
    n.querySelector('.timer-add').onclick=()=>{const ms=parse(duration.value);if(!ms)return alert('Use 30s, 25m, 2h, 1d, etc.');AlarmService.add({type:'timer',at:Date.now()+ms,label:timerLabel.value.trim()});duration.value='';timerLabel.value=''};
    n.querySelector('.reminder-add').onclick=()=>{const at=new Date(reminderAt.value).getTime();if(!Number.isFinite(at)||at<=Date.now())return alert('Choose a future date and time.');AlarmService.add({type:'reminder',at,label:reminderLabel.value.trim()});reminderLabel.value='';reminderAt.value=''};
    duration.onkeydown=e=>{if(e.key==='Enter')n.querySelector('.timer-add').click()};reminderAt.onkeydown=e=>{if(e.key==='Enter')n.querySelector('.reminder-add').click()};
    this.window=new ApplicationWindow({title:'Timers & Reminders',label:`timers-${Date.now()}`,x:opts.x,y:opts.y,width:opts.width||'560',height:opts.height||'500',launcher:{name:'TimerWindow',opts:{...opts}},mount:n,onclose:()=>{clearInterval(repaint);unsub();n.remove()}})
  }
}

class CalendarWindow{
  constructor(opts={}){
    const n=mount('#calendar-template');
    const content=n.querySelector('.calendar-content'), status=n.querySelector('.calendar-status'), period=n.querySelector('.calendar-period');
    const refresh=n.querySelector('.calendar-refresh'), newBtn=n.querySelector('.calendar-new');
    const viewBtns=[...n.querySelectorAll('.calendar-views button')];
    let events=[], view=localStorage.getItem('browseros-calendar-view')||'month', cursor=new Date();
    let lastSyncAt=0, loading=false, disposed=false, syncTimer=null;
    newBtn.disabled=false;
    cursor.setHours(12,0,0,0);
    const escHtml=v=>esc(String(v??''));
    const startOfWeek=d=>{const x=new Date(d);x.setDate(x.getDate()-x.getDay());x.setHours(0,0,0,0);return x};
    const eventDate=e=>e.start?new Date(e.start):null;
    const dated=()=>events.filter(e=>eventDate(e)&&!isNaN(eventDate(e)));
    const sameDay=(a,b)=>a&&b&&a.getFullYear()===b.getFullYear()&&a.getMonth()===b.getMonth()&&a.getDate()===b.getDate();
    const fmtTime=e=>{if(e.allDay)return 'All day';const d=eventDate(e);return d?d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}):''};
    const uiIndex=e=>events.indexOf(e);
    const eventPill=e=>`<button class="cal-event" data-event="${uiIndex(e)}" title="${escHtml(e.display||e.subject)}"><span>${escHtml(fmtTime(e))}</span><b>${escHtml(e.subject||'Event')}</b>${e.location?`<small>${escHtml(e.location)}</small>`:''}${e.source==='browseros-local'?'<i class="cal-local-badge">Local</i>':''}</button>`;
    const setPeriod=txt=>period.textContent=txt;
    const bindEvents=()=>content.querySelectorAll('[data-event]').forEach(el=>el.onclick=ev=>{ev.stopPropagation();const item=events[Number(el.dataset.event)];if(item)openEditor(item)});
    const renderAgenda=()=>{
      const now=new Date(); const list=dated().filter(e=>eventDate(e)>=new Date(now.getTime()-86400000)).sort((a,b)=>eventDate(a)-eventDate(b));
      setPeriod(cursor.toLocaleDateString([],{month:'long',year:'numeric'}));
      if(!list.length){content.innerHTML='<div class="calendar-empty">No dated events were found.</div>';return}
      const groups=new Map(); list.forEach(e=>{const d=eventDate(e),k=d.toDateString();if(!groups.has(k))groups.set(k,[]);groups.get(k).push(e)});
      content.innerHTML=[...groups.values()].map(g=>{const d=eventDate(g[0]);return `<section class="agenda-day"><div class="agenda-day-label"><b>${d.toLocaleDateString([],{weekday:'short'})}</b><strong>${d.getDate()}</strong><span>${d.toLocaleDateString([],{month:'long'})}</span></div><div class="agenda-day-events">${g.map(eventPill).join('')}</div></section>`}).join('');bindEvents();
    };
    const renderWeek=()=>{
      const first=startOfWeek(cursor); setPeriod(`${first.toLocaleDateString([],{month:'short',day:'numeric'})} – ${new Date(first.getTime()+6*86400000).toLocaleDateString([],{month:'short',day:'numeric',year:'numeric'})}`);
      const days=Array.from({length:7},(_,i)=>new Date(first.getTime()+i*86400000));
      content.innerHTML=`<div class="week-grid">${days.map(d=>{const ev=dated().filter(e=>sameDay(eventDate(e),d)).sort((a,b)=>eventDate(a)-eventDate(b));return `<section class="week-day ${sameDay(d,new Date())?'today':''}" data-new-date="${d.toISOString()}"><header><b>${d.toLocaleDateString([],{weekday:'short'})}</b><strong>${d.getDate()}</strong></header><div>${ev.map(eventPill).join('')||'<span class="cal-none">—</span>'}</div></section>`}).join('')}</div>`;bindEvents();content.querySelectorAll('[data-new-date]').forEach(el=>el.ondblclick=()=>openEditor(null,new Date(el.dataset.newDate)));
    };
    const monthMatrix=(year,month)=>{const first=new Date(year,month,1), start=new Date(year,month,1-first.getDay());return Array.from({length:42},(_,i)=>new Date(start.getFullYear(),start.getMonth(),start.getDate()+i))};
    const renderMonth=()=>{
      const y=cursor.getFullYear(),m=cursor.getMonth(); setPeriod(cursor.toLocaleDateString([],{month:'long',year:'numeric'}));
      const days=monthMatrix(y,m);
      content.innerHTML=`<div class="month-weekdays">${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(x=>`<span>${x}</span>`).join('')}</div><div class="month-grid">${days.map(d=>{const ev=dated().filter(e=>sameDay(eventDate(e),d)).sort((a,b)=>eventDate(a)-eventDate(b));return `<section class="month-day ${d.getMonth()!==m?'outside':''} ${sameDay(d,new Date())?'today':''}" data-new-date="${d.toISOString()}"><header>${d.getDate()}</header><div>${ev.slice(0,4).map(eventPill).join('')}${ev.length>4?`<small class="cal-more">+${ev.length-4} more</small>`:''}</div></section>`}).join('')}</div>`;bindEvents();content.querySelectorAll('[data-new-date]').forEach(el=>el.ondblclick=e=>{if(!e.target.closest('[data-event]'))openEditor(null,new Date(el.dataset.newDate))});
    };
    const miniMonth=(year,month)=>{const first=new Date(year,month,1), start=new Date(year,month,1-first.getDay()), cells=Array.from({length:42},(_,i)=>new Date(start.getFullYear(),start.getMonth(),start.getDate()+i));return `<section class="year-month"><h3>${new Date(year,month,1).toLocaleDateString([],{month:'long'})}</h3><div class="year-weekdays">${['S','M','T','W','T','F','S'].map(x=>`<span>${x}</span>`).join('')}</div><div class="year-days">${cells.map(d=>{const count=dated().filter(e=>sameDay(eventDate(e),d)).length;return `<button class="year-day ${d.getMonth()!==month?'outside':''} ${sameDay(d,new Date())?'today':''}" data-date="${d.toISOString()}"><span>${d.getDate()}</span>${count?`<i>${count}</i>`:''}</button>`}).join('')}</div></section>`};
    const renderYear=()=>{const y=cursor.getFullYear();setPeriod(String(y));content.innerHTML=`<div class="year-grid">${Array.from({length:12},(_,m)=>miniMonth(y,m)).join('')}</div>`;content.querySelectorAll('.year-day').forEach(b=>b.onclick=()=>{cursor=new Date(b.dataset.date);view='agenda';syncView();render()})};
    const render=()=>{if(view==='agenda')renderAgenda();else if(view==='week')renderWeek();else if(view==='year')renderYear();else renderMonth()};
    const syncView=()=>{viewBtns.forEach(b=>b.classList.toggle('active',b.dataset.view===view));localStorage.setItem('browseros-calendar-view',view)};
    const move=dir=>{if(view==='agenda'||view==='week'){cursor.setDate(cursor.getDate()+dir*7)}else if(view==='year'){cursor.setFullYear(cursor.getFullYear()+dir)}else{cursor.setMonth(cursor.getMonth()+dir)}render()};
    const toLocalInput=d=>{const x=new Date(d);if(isNaN(x))return '';const pad=v=>String(v).padStart(2,'0');return `${x.getFullYear()}-${pad(x.getMonth()+1)}-${pad(x.getDate())}T${pad(x.getHours())}:${pad(x.getMinutes())}`};
    const defaultRange=base=>{const s=new Date(base||cursor);s.setSeconds(0,0);if(base==null){s.setHours(Math.max(new Date().getHours()+1,9),0,0,0)}else if(s.getHours()===0&&s.getMinutes()===0){s.setHours(9,0,0,0)}const e=new Date(s.getTime()+3600000);return[s,e]};
    const openEditor=(item=null,baseDate=null)=>{
      document.querySelector('.calendar-editor-overlay')?.remove();
      const [ds,de]=defaultRange(baseDate); const start=item?.start?new Date(item.start):ds, end=item?.end?new Date(item.end):de;
      const localItem=!!item&&item.source==='browseros-local';
      const o=document.createElement('div');o.className='calendar-editor-overlay';
      if(item&&!localItem){
        o.innerHTML=`<form class="calendar-editor"><header><strong>Event details</strong><button type="button" class="calendar-editor-x">×</button></header><label><span>Title</span><input class="ce-title" readonly value="${escHtml(item.subject||'')}"></label><div class="ce-row"><label><span>Start</span><input class="ce-start" type="datetime-local" readonly value="${toLocalInput(start)}"></label><label><span>End</span><input class="ce-end" type="datetime-local" readonly value="${toLocalInput(end)}"></label></div><label class="ce-check"><input class="ce-allday" type="checkbox" disabled ${item.allDay?'checked':''}><span>All day</span></label><label><span>Location</span><input class="ce-location" readonly value="${escHtml(item.location||'')}"></label><div class="ce-message">This event is synced from Outlook and is read-only in BrowserOS.</div><footer><button type="button" class="ce-open">Open Outlook Web</button><span></span><button type="button" class="ce-cancel">Close</button></footer></form>`;
      }else{
        o.innerHTML=`<form class="calendar-editor"><header><strong>${localItem?'Edit local event':'New event'}</strong><button type="button" class="calendar-editor-x">×</button></header><label><span>Title</span><input class="ce-title" required value="${escHtml(item?.subject||'')}"></label><div class="ce-row"><label><span>Start</span><input class="ce-start" type="datetime-local" required value="${toLocalInput(start)}"></label><label><span>End</span><input class="ce-end" type="datetime-local" required value="${toLocalInput(end)}"></label></div><label class="ce-check"><input class="ce-allday" type="checkbox" ${item?.allDay?'checked':''}><span>All day</span></label><label><span>Location</span><input class="ce-location" value="${escHtml(item?.location||'')}"></label>${localItem?'':`<label class="ce-check ce-sync-row"><input class="ce-sync" type="checkbox" checked><span>Sync this event with Outlook</span></label><label class="ce-check ce-autosave-row"><input class="ce-autosave" type="checkbox" checked><span>Save automatically with BrowserOS Outlook Companion</span></label><div class="ce-companion-status">Checking Outlook Companion…</div>`}<div class="ce-message">${localItem?'Stored only in BrowserOS. This event is not sent to Outlook.':'Choose whether this event stays local or is also created in Outlook.'}</div><footer>${localItem?'<button type="button" class="ce-delete danger">Delete</button>':'<span></span>'}<span></span><button type="button" class="ce-cancel">Cancel</button><button type="submit" class="ce-save">${localItem?'Save':'Create event'}</button></footer></form>`;
      }
      document.body.appendChild(o);const form=o.querySelector('form'),msg=o.querySelector('.ce-message'),save=o.querySelector('.ce-save');
      const close=()=>o.remove();o.querySelector('.calendar-editor-x').onclick=close;o.querySelector('.ce-cancel').onclick=close;o.onclick=e=>{if(e.target===o)close()};
      const open=o.querySelector('.ce-open');if(open)open.onclick=()=>window.open('https://outlook.live.com/calendar/0/view/month','_blank','noopener');
      if(item&&!localItem)return;
      const autoBox=o.querySelector('.ce-autosave'),syncBox=o.querySelector('.ce-sync'),companionStatus=o.querySelector('.ce-companion-status');
      const updateSyncUi=()=>{
        if(!syncBox)return;
        const sync=syncBox.checked;
        if(autoBox)autoBox.closest('label').hidden=!sync;
        if(companionStatus)companionStatus.hidden=!sync;
        msg.textContent=sync?'BrowserOS will create the event in Outlook.':'This event will stay only in BrowserOS and can be edited or deleted here.';
      };
      const refreshCompanion=async()=>{
        if(!autoBox||!companionStatus)return;
        try{
          const r=await fetch('/api/outlook/automation/status',{cache:'no-store'}),d=await r.json();
          if(d.connected){companionStatus.textContent='Outlook Companion connected · automatic Save available';companionStatus.classList.add('connected');autoBox.disabled=false;}
          else if(d.prepared){companionStatus.textContent='Outlook Companion prepared but not currently detected';companionStatus.classList.remove('connected');autoBox.checked=true;autoBox.disabled=false;}
          else{companionStatus.textContent='Outlook Companion has not been prepared yet';companionStatus.classList.remove('connected');autoBox.checked=false;autoBox.disabled=true;}
        }catch{companionStatus.textContent='Could not check Outlook Companion';autoBox.checked=false;autoBox.disabled=true}
      };
      const waitForAutomation=async id=>{
        const deadline=Date.now()+55000;let last='';
        while(Date.now()<deadline&&o.isConnected){
          await new Promise(r=>setTimeout(r,700));
          try{
            const r=await fetch(`/api/outlook/automation/result/${encodeURIComponent(id)}`,{cache:'no-store'}),d=await r.json();if(!r.ok)continue;
            if(d.status!==last){last=d.status;if(d.status==='opened')msg.textContent='Outlook opened · verifying event…';else if(d.status==='verified')msg.textContent='Verified · clicking Save…';else if(d.status==='save-clicked')msg.textContent='Save clicked · waiting for Outlook confirmation…';}
            if(d.status==='saved'){msg.textContent='Saved in Outlook ✓';setTimeout(()=>load(true),2500);setTimeout(close,1200);return true;}
            if(d.status==='failed')throw new Error(d.error||'Outlook Companion could not save this event automatically.');
          }catch(err){if(String(err?.message||'').includes('automatically'))throw err;}
        }
        msg.textContent='Outlook is open. Automatic Save was not confirmed; check the event tab.';save.disabled=false;return false;
      };
      form.onsubmit=async e=>{
        e.preventDefault();
        const payload={subject:o.querySelector('.ce-title').value.trim(),start:o.querySelector('.ce-start').value,end:o.querySelector('.ce-end').value,location:o.querySelector('.ce-location').value.trim(),allDay:o.querySelector('.ce-allday').checked};
        if(!payload.subject)return;save.disabled=true;
        try{
          if(localItem||!syncBox?.checked){
            msg.textContent=localItem?'Saving local event…':'Creating local event…';
            const url=localItem?`/api/calendar/local-events/${encodeURIComponent(item.id)}`:'/api/calendar/local-events';
            const r=await fetch(url,{method:localItem?'PUT':'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)}),d=await r.json();if(!r.ok)throw new Error(d.error||'Could not save local event.');
            msg.textContent='Saved locally ✓';await load(false);setTimeout(close,500);return;
          }
          payload.autoSave=!!autoBox?.checked&&!autoBox?.disabled;msg.textContent='Opening Outlook Web…';
          const r=await fetch('/api/outlook/events',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)}),d=await r.json();if(!r.ok)throw new Error(d.error||'Could not open Outlook event.');
          msg.textContent=d.message||'Opened in Outlook Web.';if(d.pendingAutomation&&d.automationRequestId)await waitForAutomation(d.automationRequestId);else setTimeout(close,1800);
        }catch(err){msg.textContent=err.message;save.disabled=false}
      };
      const del=o.querySelector('.ce-delete');if(del)del.onclick=async()=>{if(!confirm(`Delete local event “${item.subject||'Event'}”?`))return;del.disabled=true;try{const r=await fetch(`/api/calendar/local-events/${encodeURIComponent(item.id)}`,{method:'DELETE'}),d=await r.json();if(!r.ok)throw new Error(d.error||'Could not delete event.');await load(false);close()}catch(err){msg.textContent=err.message;del.disabled=false}};
      syncBox?.addEventListener('change',updateSyncUi);updateSyncUi();refreshCompanion();setTimeout(()=>o.querySelector('.ce-title').focus(),0);
    };
    const syncStamp=ts=>{const d=new Date(ts||Date.now());return d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:'2-digit'})};
    const load=async(force=false)=>{
      if(disposed||loading)return false;
      loading=true;status.textContent='Outlook ICS · syncing…';refresh.disabled=true;
      try{
        const r=await fetch(`/api/outlook/events${force?'?refresh=1':''}`,{cache:'no-store'}),d=await r.json();
        if(!r.ok)throw new Error(d.error||'Could not refresh the published Outlook calendar.');
        events=d.events||[];lastSyncAt=Number(d.syncedAt)||Date.now();
        const stale=d.stale?' · stale cache':'';
        const localCount=events.filter(e=>e.source==='browseros-local').length,outlookCount=events.length-localCount;status.textContent=`Calendar · ${outlookCount} Outlook · ${localCount} local · synced ${syncStamp(lastSyncAt)}${d.cached?' · cached':''}${stale}`;
        if(d.warning)status.title=d.warning;else status.removeAttribute('title');
        render();
        return true;
      }catch(e){
        status.textContent=`Outlook ICS · ${e.message}`;
        if(!events.length)content.innerHTML=`<div class="calendar-empty">${escHtml(e.message)}<br><small>The published calendar feed could not be loaded. Use Refresh to try again.</small></div>`;
        return false;
      }finally{loading=false;refresh.disabled=false}
    };
    const refreshIfStale=()=>{if(disposed||document.hidden||loading)return;if(!lastSyncAt||Date.now()-lastSyncAt>=120_000)load(true)};
    const onVisibility=()=>{if(!document.hidden)refreshIfStale()};
    newBtn.onclick=()=>openEditor(null,cursor);refresh.onclick=()=>load(true); n.querySelector('.calendar-prev').onclick=()=>move(-1);n.querySelector('.calendar-next').onclick=()=>move(1);n.querySelector('.calendar-today').onclick=()=>{cursor=new Date();render()};
    viewBtns.forEach(b=>b.onclick=()=>{view=b.dataset.view;syncView();render()});syncView();
    window.addEventListener('focus',refreshIfStale);document.addEventListener('visibilitychange',onVisibility);
    syncTimer=setInterval(()=>{if(!document.hidden&&n.isConnected)refreshIfStale()},30_000);
    const cleanup=()=>{disposed=true;if(syncTimer)clearInterval(syncTimer);window.removeEventListener('focus',refreshIfStale);document.removeEventListener('visibilitychange',onVisibility);document.querySelector('.calendar-editor-overlay')?.remove();n.remove()};
    this.window=new ApplicationWindow({title:'Calendar',label:`CalendarWindow-${Date.now()}`,x:opts.x,y:opts.y,width:opts.width||'980',height:opts.height||'720',launcher:{name:'CalendarWindow',opts:{...opts}},mount:n,onclose:cleanup});
    (async()=>{
      try{
        const r=await fetch('/api/outlook/events/cache',{cache:'no-store'}),d=await r.json();
        if(d.available){
          events=d.events||[];lastSyncAt=Number(d.syncedAt)||0;
          const outCount=Number(d.outlookCount??events.filter(e=>e.source!=='browseros-local').length),localCount=Number(d.localCount??events.filter(e=>e.source==='browseros-local').length);status.textContent=`Calendar · ${outCount} Outlook · ${localCount} local${lastSyncAt?` · cached ${syncStamp(lastSyncAt)}`:''}`;
          render();
        }
      }catch{}
      if(!lastSyncAt||Date.now()-lastSyncAt>=120_000)await load(true);
    })();
  }
}

class CommandPalette{
  static open(){
    const old=document.querySelector('.command-palette-overlay');if(old){old.remove();return}
    const o=document.createElement('div');o.className='command-palette-overlay';
    const actions=[['Terminal',()=>new TerminalWindow()],['System Monitor',()=>new SystemWindow()],['Ecosystem',()=>new EcosystemWindow()],['Tamagotchi',()=>new TamagotchiWindow()],['Processes',()=>new ProcessesWindow()],['Network',()=>new NetworkWindow()],['Disks',()=>new DisksWindow()],['Services',()=>new ServicesWindow()],['News',()=>new NewsWindow()],['Weather',()=>new WeatherWindow()],['Agenda',()=>new CalendarWindow()],['Clipboard',()=>new ClipboardWindow()],['Notes',()=>new NotesWindow()],['Todo',()=>new TodoWindow()],['Bookmarks',()=>new BookmarksWindow()],['Search',()=>new SearchWindow()],['Launch app',()=>new LauncherWindow()],['Timers & Reminders',()=>new TimerWindow()],['Window Appearance',()=>new AppearanceWindow()],['Riftbreakers VTT',()=>new RiftbreakersWindow()],['Geomancy',()=>new GeomancyWindow()],['Tiny Web Agent',()=>new TinyAgentWindow()],['Skills Editor',()=>new SkillEditorWindow()],['Tool Editor',()=>new ToolEditorWindow()],['Scheduled Tasks',()=>new ScheduledTasksWindow()]];
    o.innerHTML='<div class="command-palette"><input placeholder="Type a command or ask Browser-OS…"><div></div></div>';
    document.body.appendChild(o);const input=o.querySelector('input'),list=o.querySelector('.command-palette>div');
    const draw=()=>{const q=input.value.toLowerCase().trim();const m=actions.filter(x=>x[0].toLowerCase().includes(q));list.innerHTML=m.map((x,i)=>`<button data-i="${i}">${esc(x[0])}</button>`).join('');list.querySelectorAll('[data-i]').forEach((b,i)=>b.onclick=()=>{m[i][1]();o.remove()})};
    input.oninput=draw;input.onkeydown=e=>{if(e.key==='Escape')o.remove();if(e.key==='Enter'){e.preventDefault();const exact=actions.find(x=>x[0].toLowerCase()===input.value.trim().toLowerCase());if(exact){exact[1]();o.remove()}}};o.onclick=e=>{if(e.target===o)o.remove()};draw();input.focus()
  }
}

function fmtBytes(v=0){const u=['B','KB','MB','GB','TB'];let i=0,n=Number(v)||0;while(n>=1024&&i<u.length-1){n/=1024;i++}return `${n.toFixed(i>1?1:0)} ${u[i]}`}
function fmtRate(v){return fmtBytes(v)+'/s'}
function formatRemain(ms){if(ms<=0)return'DONE';const s=Math.ceil(ms/1000),h=Math.floor(s/3600),m=Math.floor((s%3600)/60),r=s%60;return h?`${h}h ${m}m`:m?`${m}m ${r}s`:`${r}s`}
Object.assign(window,{NotesWindow,TodoWindow,ClipboardWindow,BookmarksWindow,SearchWindow,LauncherWindow,NetworkWindow,DisksWindow,ProcessesWindow,ServicesWindow,WeatherWindow,TimerWindow,CalendarWindow,CommandPalette,SearchEngines:engines,AlarmService});
})();
