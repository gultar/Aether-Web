const TamagotchiWidget = (() => {
  const KEY='browser-os-tamagotchi-v2';
  const OLD_KEY='browser-os-tamagotchi-v1';
  const NEGLECT_DEATH_AFTER_MS=24*60*60*1000;
  const clamp=(v,a=0,b=100)=>Math.max(a,Math.min(b,v));
  const listeners=new Set();
  const nowId=()=>`pet-${Date.now()}-${Math.random().toString(36).slice(2,7)}`;
  let lastAction={petId:null,type:'idle',startedAt:0,until:0};

  // Sprite silhouettes traced from the user's reference sheet, then lightly recolored for Browser-OS.
  // Each pet is an 18×18 canvas bitmap; no external image assets are used.
  const species={
    mossbit:{label:'Mossbit',grid:18,palette:{K:'#05070a',A:'#b8c4ff',B:'#879fe8',C:'#e8ebff',D:'#ef707a'},bitmap:[
      '..................',
      '..................',
      '....KK.....KK.....',
      '...KBKKKK.KBK.....',
      '...KKBBBBKBAK.KK..',
      '...KAAAAAABK.KBCK.',
      '.KKABAKKKBCK..KCK.',
      '.KAAKBKKBCKK..KBK.',
      '.KKKKKAACKKK.KKAK.',
      '..KCCCCACCCKKAAK..',
      '...KKKKAABKKKAAAK.',
      '.....KBBBAABKAKKK.',
      '.....KCKKABAAKAKK.',
      '.....KBKBAKABKCBK.',
      '....KKCKCKKKKKKCK.',
      '...KDBKDBDK.KDDBK.',
      '...KKKKKKK..KKKKK.',
      '..................'
    ]},
    voltfin:{label:'Voltfin',grid:18,palette:{K:'#050505',A:'#ffd54a',B:'#f7a62a',C:'#fff14a',D:'#25201d',E:'#dbe5f0'},bitmap:[
      '..................',
      '.......KKKKKKKKK..',
      '.....KKCCCACCCAK..',
      '..KKKABKKAKKKAK...',
      '..KDKKKBBKADKCKKK.',
      '...KAAAAAAEKCCCAK.',
      '.KKAAAAKKAKCACAK..',
      '.KAAKAKKAABKCCKKK.',
      '.KKKKKAAABBKCAAAK.',
      '..KAAAABBBKAAAKKK.',
      '..KKKKKKKKBKKKABK.',
      '.KABKBBKBBBBAAABK.',
      '.KABKKKDKKKKKAABK.',
      '.KAKKDDEDDDDKBBK..',
      '.KAABKKKKKKKKKKKK.',
      '.KABBKBKKKKKAAKAK.',
      '..KKKKKKK..KKKKKK.',
      '..................'
    ]},
    cinderhorn:{label:'Cinderhorn',grid:18,palette:{K:'#080503',A:'#f36a24',B:'#bd4a22',C:'#ffe2b7'},bitmap:[
      '..................',
      '..................',
      '.......KKKKK......',
      '......KAAAAAK.....',
      '.....KKAKKAABK....',
      '...KKAAAAKKABK....',
      '..KAAAAAKKKAABK...',
      '..KKKKAAAAAAABK...',
      '...KBBAAAAAAABK...',
      '....KKKKKAABBK....',
      '.....KKBBBBKAK....',
      '....KCKAAAKCAAK...',
      '....KKKAAAKKKAK...',
      '......KKAABBKABK..',
      '....KKABKKKKAABK..',
      '...KCKCBK.KCKCKCK.',
      '...KKKKKK.KKKKKKK.',
      '..................'
    ]},
    shellbyte:{label:'Shellbyte',grid:18,palette:{K:'#050505',A:'#dcebf0',B:'#fac947',C:'#e84128',D:'#e99139',E:'#b8ced9',F:'#f56a26'},bitmap:[
      '..................',
      '..KK...KKKK..KKK..',
      '..KKKKKAAAAKKKK...',
      '...KKKKAAAAAKK....',
      '....KKAAAKKAK..KK.',
      '.KKKAAAAKKAAKKKBK.',
      '.KBKAAAAAAAAKDBK..',
      '..KBKAKKKAKKCCCBK.',
      '..KBDKFFBKFKCCCDK.',
      '...KKKKKKKKKKCCKK.',
      '..KKBKBAKAEDKKKBK.',
      '.KBBDKKKKKKKKCCEK.',
      '.KBDKKDKAEKEDKAK..',
      '.KKKKKKAKEKEKKK...',
      '...KKAEKKKKKAEKK..',
      '..KBBKBBKKKBBKBBK.',
      '..KKKKKKK.KKKKKKK.',
      '..................'
    ]},
    noctwing:{label:'Noctwing',grid:18,palette:{K:'#050505',A:'#f36a24',B:'#bd4a22',C:'#2d5198',D:'#55403a',E:'#cc8b5b',F:'#8f5e40',G:'#ffe2b7'},bitmap:[
      '..................',
      '......KKKKK..KKK..',
      '.KK..KEEEFEKKDFK..',
      '.KEKKKEF.KFFDCK...',
      '.KKKEFFK.DDKKK....',
      '.KEFDKDDDDBCK.....',
      '.KKKKKKBBBCAK.....',
      '..KBBBBBAAAACK....',
      '...KKKKKAAACAK....',
      '.....KCAAAAKACK...',
      '...KKAACAKKCCBK...',
      '..KAKAAAKAABCBKKK.',
      '..KBKCAAKABBKBKAK.',
      '...KKACABKKKBCKCK.',
      '..KKBKAAABBKCBBK..',
      '.KGKGBKKKKKGKGKGK.',
      '.KKKKKKK...KKKKKK.',
      '..................'
    ]},
    ironpup:{label:'Ironpup',grid:18,palette:{K:'#050505',A:'#f7a62a',B:'#fff0bb',C:'#ffd54a',D:'#f7d6b8',E:'#25201d'},bitmap:[
      '..................',
      '..................',
      '..................',
      '......KKK.KKKK....',
      '.....KCCCKCCCCK...',
      '....KCAKKCAAKACK..',
      '...KCAAAKCAAKKKK..',
      '...KCAKKKAAKK.....',
      '...KAKAAAAAAK.....',
      '..KCAAAAAAAAAK.KK.',
      '.KAKAAAAKAAAAAKCK.',
      '.KAKAAAAKAAAAABK..',
      '.KAAAKAAAAAAABBDK.',
      '.KBBKBKKBBBBBBBDK.',
      '..KBBBBBBBBKDKDDK.',
      '.KEKKKKKKEDKKEDDK.',
      '.KKKK...KKK.KKKK..',
      '..................'
    ]}
  };
  function freshPet(sp='mossbit',name){
    const now=Date.now();
    return {id:nowId(),name:name||species[sp]?.label||'Bit',species:species[sp]?sp:'mossbit',bornAt:now,updatedAt:now,lastCareAt:now,nextPoopAt:now+35*60_000,hunger:82,happiness:84,energy:78,hygiene:94,health:100,poop:0,sleeping:false,dead:false,deadAt:null};
  }
  function fresh(){const p=freshPet('mossbit','Mochi');return {activeId:p.id,pets:[p]}}
  function migrateOld(){
    try{const old=JSON.parse(localStorage.getItem(OLD_KEY)||'null');if(!old)return null;const p={...freshPet('mossbit',old.name||'Mochi'),...old,id:nowId(),species:'mossbit'};return{activeId:p.id,pets:[p]}}catch(_){return null}
  }
  function load(){
    try{
      const saved=JSON.parse(localStorage.getItem(KEY)||'null');
      if(saved?.pets?.length){
        const pets=saved.pets.map(p=>({...freshPet(p.species||'mossbit',p.name),...p,id:p.id||nowId(),species:species[p.species]?p.species:'mossbit',lastCareAt:Number.isFinite(Number(p.lastCareAt))?Number(p.lastCareAt):Date.now()}));
        return {activeId:pets.some(p=>p.id===saved.activeId)?saved.activeId:pets[0].id,pets};
      }
      return migrateOld()||fresh();
    }catch(_){return fresh()}
  }
  let state=load();
  function save(){localStorage.setItem(KEY,JSON.stringify(state))}
  const active=()=>state.pets.find(p=>p.id===state.activeId)||state.pets[0];
  function notify(){for(const fn of listeners)try{fn(state,active(),lastAction)}catch(_){} }
  function advancePet(p,now=Date.now()){
    if(p.dead){p.health=0;p.sleeping=false;p.updatedAt=now;return p}
    const neglectedFor=Math.max(0,now-(Number(p.lastCareAt)||now));
    if(Number(p.health)<=0){
      if(neglectedFor>=NEGLECT_DEATH_AFTER_MS){p.health=0;p.dead=true;p.deadAt=p.deadAt||now;p.sleeping=false;p.updatedAt=now;return p}
      p.health=1;
    }
    const dt=Math.max(0,Math.min(24*60,(now-(Number(p.updatedAt)||now))/60_000));
    if(!dt)return p;
    p.hunger=clamp(p.hunger-dt*(p.sleeping?.07:.14));
    p.happiness=clamp(p.happiness-dt*(p.sleeping?.025:.055));
    p.energy=clamp(p.energy+dt*(p.sleeping?.28:-.075));
    p.hygiene=clamp(p.hygiene-dt*(.035+p.poop*.035));
    while(now>=p.nextPoopAt){p.poop=Math.min(4,p.poop+1);p.nextPoopAt+=((35+Math.random()*25)*60_000)}
    const critical=Math.min(p.hunger,p.happiness,p.energy,p.hygiene);
    if(critical<18)p.health=clamp(p.health-dt*.12);else if(critical>45)p.health=clamp(p.health+dt*.04);
    if(neglectedFor>=NEGLECT_DEATH_AFTER_MS&&critical<18)p.health=0;
    if(p.health<=0){
      if(neglectedFor>=NEGLECT_DEATH_AFTER_MS){p.health=0;p.dead=true;p.deadAt=p.deadAt||now;p.sleeping=false;lastAction={petId:p.id,type:'dead',startedAt:now,until:0}}
      else p.health=1;
    }
    p.updatedAt=now;return p;
  }
  function advance(now=Date.now()){for(const p of state.pets)advancePet(p,now);save();return state}
  function act(type){
    advance();const p=active();if(!p||p.dead)return;
    if(type==='feed'){p.hunger=clamp(p.hunger+27);p.happiness=clamp(p.happiness+3);lastAction={petId:p.id,type:'eat',startedAt:Date.now(),until:Date.now()+2600}}
    if(type==='play'){p.happiness=clamp(p.happiness+22);p.energy=clamp(p.energy-9);p.hunger=clamp(p.hunger-4);lastAction={petId:p.id,type:'play',startedAt:Date.now(),until:Date.now()+2800}}
    if(type==='clean'){p.hygiene=100;p.poop=0;lastAction={petId:p.id,type:'clean',startedAt:Date.now(),until:Date.now()+2300}}
    if(type==='sleep'){p.sleeping=!p.sleeping;lastAction={petId:p.id,type:p.sleeping?'sleep':'happy',startedAt:Date.now(),until:Date.now()+1400}}
    if(type==='medicine'){p.health=clamp(p.health+28);p.happiness=clamp(p.happiness-3);lastAction={petId:p.id,type:'medicine',startedAt:Date.now(),until:Date.now()+2200}}
    if(type==='pet'){p.happiness=clamp(p.happiness+8);lastAction={petId:p.id,type:'happy',startedAt:Date.now(),until:Date.now()+1200}}
    p.lastCareAt=Date.now();p.updatedAt=p.lastCareAt;save();notify();
  }
  function rename(name){const p=active(),v=String(name||'').trim().slice(0,18);if(p&&v){p.name=v;save();notify()}}
  function selectPet(id){if(state.pets.some(p=>p.id===id)){state.activeId=id;save();notify()}}
  function changeSpecies(sp){const p=active();if(p&&!p.dead&&species[sp]){p.species=sp;save();lastAction={petId:p.id,type:'happy',startedAt:Date.now(),until:Date.now()+1000};notify()}}
  function addPet(sp='mossbit',name){if(!species[sp])sp='mossbit';const p=freshPet(sp,String(name||species[sp].label).trim().slice(0,18)||species[sp].label);state.pets.push(p);state.activeId=p.id;save();lastAction={petId:p.id,type:'happy',startedAt:Date.now(),until:Date.now()+1600};notify();return p}
  function removePet(){if(state.pets.length<=1)return false;const idx=state.pets.findIndex(p=>p.id===state.activeId);if(idx<0)return false;state.pets.splice(idx,1);state.activeId=state.pets[Math.max(0,idx-1)]?.id||state.pets[0].id;save();notify();return true}
  function resetPet(){const old=active();if(!old)return;const p=freshPet(old.species,old.name);p.id=old.id;const i=state.pets.findIndex(x=>x.id===old.id);state.pets[i]=p;lastAction={petId:p.id,type:'happy',startedAt:Date.now(),until:Date.now()+1500};save();notify()}
  function subscribe(fn){listeners.add(fn);fn(advance(),active(),lastAction);return()=>listeners.delete(fn)}

  function mood(p){if(p.dead)return'dead';const min=Math.min(p.hunger,p.happiness,p.energy,p.hygiene,p.health);if(p.sleeping)return'sleep';if(p.health<25||min<18)return'sad';if(p.happiness>78&&p.hunger>55)return'happy';return'idle'}
  function statusText(p){if(p.dead)return'has died';if(p.health<25)return'feels sick';if(p.poop>0&&p.hygiene<55)return'needs cleaning';if(p.hunger<30)return'is hungry';if(p.energy<25)return'is sleepy';if(p.happiness<32)return'wants attention';if(p.sleeping)return'is sleeping';return'is doing well'}
  function ageText(ms){const m=Math.max(0,Math.floor(ms/60_000));if(m<60)return`${m}m`;const h=Math.floor(m/60);if(h<48)return`${h}h`;return`${Math.floor(h/24)}d ${h%24}h`}
  const playLabels={mossbit:'is pouncing around',voltfin:'is sparking with excitement',cinderhorn:'is doing little charges',shellbyte:'is rolling around',noctwing:'is flying loops',ironpup:'has the zoomies'};
  function liveStatus(p,a){if(p.dead)return'has died';if(a?.petId===p.id&&Date.now()<a.until){if(a.type==='play')return playLabels[p.species]||'is playing';if(a.type==='eat')return'is eating';if(a.type==='medicine')return'is taking medicine';if(a.type==='clean')return'is getting cleaned';if(a.type==='happy')return'is happy'}return statusText(p)}

  function mount(host,options={}){
    host.innerHTML=`<section class="tama-widget${options.docked?' tama-docked':''}">
      <header class="tama-head"><div class="tama-title"><strong class="tama-name" title="Double-click to rename">Pet</strong><small class="tama-age">age --</small></div><span class="tama-status">...</span></header>
      <div class="tama-collection">
        <select class="tama-pet-select" title="Choose pet"></select>
        <select class="tama-species-select" title="Choose sprite"></select>
        <button class="tama-add" title="Add another creature">＋</button><button class="tama-remove" title="Remove current creature">−</button><button class="tama-info" title="How fast needs change">?</button>
      </div>
      <div class="tama-rate-card" hidden><strong>Need rates (real time)</strong><span>Awake: food −8.4/h · mood −3.3/h · energy −4.5/h · clean −2.1/h base</span><span>Sleeping: food −4.2/h · mood −1.5/h · energy +16.8/h</span><span>Each mess adds −2.1 clean/h · a mess appears about every 35–60 min</span><span>Any need below 18: health −7.2/h · all main needs above 45: health +2.4/h</span><span>Neglect cannot kill the pet before 24 h · after 24 h unattended with a critical need, the pet dies permanently</span></div>
      <div class="tama-screen"><canvas class="tama-canvas" aria-label="Pixel pet"></canvas><div class="tama-hint">click pet · dbl-click name</div></div>
      <div class="tama-needs">
        <label><span>food <em data-value="hunger">--</em></span><i><b data-need="hunger"></b></i></label><label><span>mood <em data-value="happiness">--</em></span><i><b data-need="happiness"></b></i></label><label><span>energy <em data-value="energy">--</em></span><i><b data-need="energy"></b></i></label><label><span>clean <em data-value="hygiene">--</em></span><i><b data-need="hygiene"></b></i></label><label><span>health <em data-value="health">--</em></span><i><b data-need="health"></b></i></label>
      </div>
      <div class="tama-actions"><button data-tama="feed">feed</button><button data-tama="play">play</button><button data-tama="clean">clean</button><button data-tama="sleep">sleep</button><button data-tama="medicine">med</button><button data-tama="reset" title="Reset current pet">↻</button></div>
    </section>`;
    const root=host.querySelector('.tama-widget'),canvas=root.querySelector('.tama-canvas'),ctx=canvas.getContext('2d');
    const petSelect=root.querySelector('.tama-pet-select'),speciesSelect=root.querySelector('.tama-species-select'),rateCard=root.querySelector('.tama-rate-card');
    speciesSelect.innerHTML=Object.entries(species).map(([id,s])=>`<option value="${id}">${s.label}</option>`).join('');
    let disposed=false,visible=true,dpr=1,w=1,h=1,frameNo=0,lastFrame=0,current=active(),currentAction=lastAction;
    function resize(){const r=canvas.getBoundingClientRect();dpr=Math.min(2,window.devicePixelRatio||1);w=Math.max(1,r.width);h=Math.max(1,r.height);canvas.width=Math.round(w*dpr);canvas.height=Math.round(h*dpr);ctx.setTransform(dpr,0,0,dpr,0,0);ctx.imageSmoothingEnabled=false}
    const ro=new ResizeObserver(resize);ro.observe(canvas);
    const io=new IntersectionObserver(e=>{visible=!!e[0]?.isIntersecting},{threshold:.01});io.observe(root);
    function update(_state,p,a){
      current=p;currentAction=a;if(!p)return;
      petSelect.innerHTML=state.pets.map(x=>`<option value="${x.id}"${x.id===state.activeId?' selected':''}>${x.name} · ${species[x.species]?.label||x.species}</option>`).join('');
      speciesSelect.value=p.species;root.classList.toggle('tama-dead',!!p.dead);speciesSelect.disabled=!!p.dead;
      root.querySelector('.tama-name').textContent=p.name;root.querySelector('.tama-age').textContent=`age ${ageText(Date.now()-p.bornAt)}`;root.querySelector('.tama-status').textContent=`${p.name} ${liveStatus(p,a)}`;
      for(const k of['hunger','happiness','energy','hygiene','health']){const v=Math.round(p[k]);root.querySelector(`[data-need="${k}"]`).style.width=`${v}%`;root.querySelector(`[data-value="${k}"]`).textContent=`${v}%`}
      root.querySelector('[data-tama="sleep"]').textContent=p.dead?'sleep':(p.sleeping?'wake':'sleep');root.querySelector('.tama-remove').disabled=state.pets.length<=1;
      root.querySelectorAll('.tama-actions [data-tama]').forEach(btn=>{btn.disabled=!!p.dead&&btn.dataset.tama!=='reset'});
    }
    const unsub=subscribe(update);
    petSelect.onchange=()=>selectPet(petSelect.value);
    speciesSelect.onchange=()=>changeSpecies(speciesSelect.value);
    root.querySelector('.tama-add').onclick=()=>{const sp=speciesSelect.value;const n=prompt(`Name your new ${species[sp].label}:`,species[sp].label);if(n!==null)addPet(sp,n)};
    root.querySelector('.tama-remove').onclick=()=>{if(state.pets.length>1&&confirm(`Remove ${current.name}?`))removePet()};
    root.querySelector('.tama-info').onclick=()=>{rateCard.hidden=!rateCard.hidden};
    root.querySelectorAll('[data-tama]').forEach(b=>b.onclick=()=>b.dataset.tama==='reset'?(confirm(current.dead?`Start a new life for ${current.name}?`:`Reset ${current.name}?`)&&resetPet()):act(b.dataset.tama));
    canvas.addEventListener('click',()=>act('pet'));
    root.querySelector('.tama-name').addEventListener('dblclick',()=>{const v=prompt('Pet name:',current.name);if(v!==null)rename(v)});
    function drawRoom(){
      const p=current;if(!p)return;ctx.fillStyle='#07100c';ctx.fillRect(0,0,w,h);ctx.fillStyle='rgba(120,158,132,.06)';for(let x=0;x<w;x+=16)ctx.fillRect(x,0,1,h);for(let y=0;y<h;y+=16)ctx.fillRect(0,y,w,1);ctx.fillStyle='rgba(164,194,174,.14)';ctx.fillRect(0,h*.80,w,1);
      if(p.poop){for(let i=0;i<p.poop;i++){const x=w*.70+i*10,y=h*.77;ctx.fillStyle='rgba(142,112,82,.75)';ctx.fillRect(Math.round(x),Math.round(y),5,3);ctx.fillRect(Math.round(x+1),Math.round(y-2),3,2)}}
      // Sleep icons are drawn in drawSprite() so they scale with the creature size.
    }
    function drawCareEffects(kind,sp,t,ox,oy,sw,sh,px){
      const q=v=>Math.round(v), cx=ox+sw*.5, cy=oy+sh*.5;
      ctx.save();ctx.globalAlpha=.95;
      if(kind==='eat'){
        // Food visibly travels to the pet, gets bitten down, then leaves crumbs.
        const approach=Math.min(1,t/.9), chew=Math.max(0,t-.8);
        const mouthX=ox+sw*.77, mouthY=oy+sh*.60;
        const foodX=ox+sw*(1.10-(.31*approach)), foodY=oy+sh*(.57-.06*Math.sin(approach*Math.PI));
        const bites=chew<.35?0:chew<.75?1:chew<1.15?2:3;
        if(bites<3){
          const r=Math.max(px,px*(3-bites));
          ctx.fillStyle=sp==='voltfin'?'#fff36a':sp==='noctwing'?'#d68b50':'#d8b35f';
          ctx.fillRect(q(foodX-r/2),q(foodY-r/2),q(r),q(r));
          ctx.fillStyle='#6f8f45';ctx.fillRect(q(foodX),q(foodY-r*.65),Math.max(1,q(px*.65)),Math.max(1,q(px*.7)));
        }
        if(chew>0){
          ctx.fillStyle='rgba(226,191,115,.9)';
          for(let i=0;i<Math.min(4,Math.floor(chew*5));i++){
            const a=i*1.9+chew*4.2;
            ctx.fillRect(q(mouthX+Math.cos(a)*px*(1.4+i*.25)),q(mouthY+Math.sin(a)*px*(1+i*.2)),Math.max(1,q(px*.55)),Math.max(1,q(px*.55)));
          }
        }
      }else if(kind==='medicine'){
        // A capsule approaches, the pet reacts, then health crosses sparkle out.
        const approach=Math.min(1,t/.75), done=Math.max(0,t-.72);
        const x=ox+sw*(1.08-.34*approach),y=oy+sh*(.28+.18*approach);
        if(done<.55){
          ctx.fillStyle='#e89a9a';ctx.fillRect(q(x-px*1.4),q(y-px*.55),q(px*1.4),q(px*1.1));
          ctx.fillStyle='#e7e9ef';ctx.fillRect(q(x),q(y-px*.55),q(px*1.4),q(px*1.1));
        }
        if(done>0){
          ctx.fillStyle='rgba(165,226,177,.9)';
          for(let i=0;i<3;i++){
            const a=done*5+i*2.1, sx=cx+Math.cos(a)*sw*.43, sy=cy+Math.sin(a)*sh*.31;
            ctx.fillRect(q(sx-px*.8),q(sy-px*.25),q(px*1.6),Math.max(1,q(px*.5)));
            ctx.fillRect(q(sx-px*.25),q(sy-px*.8),Math.max(1,q(px*.5)),q(px*1.6));
          }
        }
      }else if(kind==='clean'){
        // Soap bubbles rise while a tiny sponge sweeps over the pet.
        const sweep=(t*.72)%1;
        const sx=ox+sw*(.10+.80*sweep), sy=oy+sh*(.20+.55*Math.abs(Math.sin(t*3.2)));
        ctx.fillStyle='rgba(237,211,96,.88)';ctx.fillRect(q(sx-px*1.5),q(sy-px),q(px*3),q(px*2));
        ctx.fillStyle='rgba(255,244,171,.8)';ctx.fillRect(q(sx-px),q(sy-px*.65),q(px*1.25),Math.max(1,q(px*.45)));
        for(let i=0;i<8;i++){
          const phase=(t*.34+i*.137)%1;
          const bx=ox+sw*(.10+((i*0.173)%0.8)), by=oy+sh*(.88-phase*.82);
          const rr=px*(.55+(i%3)*.28);
          ctx.strokeStyle=`rgba(181,226,234,${.35+.35*(1-phase)})`;ctx.lineWidth=Math.max(1,px*.28);
          ctx.strokeRect(q(bx-rr),q(by-rr),q(rr*2),q(rr*2));
        }
        ctx.fillStyle='rgba(222,244,231,.8)';
        for(let i=0;i<3;i++){const xx=ox+sw*(.25+i*.25),yy=oy+sh*(.16+.04*Math.sin(t*5+i));ctx.fillRect(q(xx),q(yy),px,px);ctx.fillRect(q(xx+px*.35),q(yy-px*.35),Math.max(1,q(px*.4)),q(px*1.6))}
      }
      ctx.restore();
    }
    function drawPlayEffects(sp,t,ox,oy,sw,sh,px){
      const q=(v)=>Math.round(v);
      ctx.save();ctx.globalAlpha=.9;
      if(sp==='mossbit'){
        // Tiny pounce stars that pop around the landing points.
        ctx.fillStyle='#dce6ff';
        for(let i=0;i<3;i++){const a=t*18+i*2.2;const x=ox+sw*(.18+.32*i)+Math.sin(a)*7,y=oy+sh*(.13+.10*i)-Math.cos(a*1.3)*6;ctx.fillRect(q(x),q(y),px*2,px);ctx.fillRect(q(x+px*.5),q(y-px*.5),px,px*2)}
      }else if(sp==='voltfin'){
        // Pixel lightning arcs.
        ctx.fillStyle='#fff36a';
        const side=(t%1)<.5?-1:1,cx=ox+sw/2+side*sw*.58,cy=oy+sh*.42;
        for(let i=0;i<4;i++){ctx.fillRect(q(cx+i*px*side),q(cy+(i%2)*px),px,px)}
        ctx.fillStyle='#ffc23a';ctx.fillRect(q(ox+sw*.18),q(oy+sh*.18),px,px);ctx.fillRect(q(ox+sw*.82),q(oy+sh*.68),px,px);
      }else if(sp==='cinderhorn'){
        // Dust kicked up by the charge.
        ctx.fillStyle='rgba(224,174,112,.8)';
        for(let i=0;i<4;i++){const x=ox+sw*.18-i*px*1.7-(t*18%10),y=oy+sh*.78+(i%2)*px;ctx.fillRect(q(x),q(y),px,px)}
      }else if(sp==='shellbyte'){
        // Little orbiting glints sell the shell roll.
        ctx.fillStyle='#f5d45c';
        for(let i=0;i<3;i++){const a=t*10+i*Math.PI*2/3,x=ox+sw/2+Math.cos(a)*sw*.62,y=oy+sh/2+Math.sin(a)*sh*.48;ctx.fillRect(q(x),q(y),px,px)}
      }else if(sp==='noctwing'){
        // Flight streaks below/behind the sprite.
        ctx.fillStyle='rgba(188,211,235,.65)';
        for(let i=0;i<3;i++){const yy=oy+sh*(.35+i*.16);ctx.fillRect(q(ox-sw*.12-i*3),q(yy),q(px*2.5),Math.max(1,q(px*.45)))}
      }else if(sp==='ironpup'){
        // Zoomie paw-dust / speed pixels.
        ctx.fillStyle='rgba(238,214,170,.72)';
        for(let i=0;i<4;i++){const x=ox+sw*.05-i*px*1.8,y=oy+sh*(.72+(i%2)*.08);ctx.fillRect(q(x),q(y),px,px)}
      }
      ctx.restore();
    }
    function drawSprite(){
      const p=current;if(!p)return;const def=species[p.species]||species.mossbit,pal=def.palette;
      const now=Date.now(),isAction=currentAction.petId===p.id&&now<currentAction.until;
      const stateName=p.dead?'dead':(isAction?currentAction.type:mood(p));
      const grid=def.grid||18;const px=Math.max(4,Math.floor(Math.min(w/(grid+8),h/(grid+8))));const sw=grid*px,sh=grid*px;
      const baseOx=Math.round((w-sw)/2),baseOy=Math.round((h-sh)/2+3);
      let dx=0,dy=stateName==='dead'?0:(stateName==='sleep'?2:((frameNo%2)?0:-1)),rot=0,sx=1,sy=1,playT=0,actionT=0;
      if(isAction) actionT=Math.max(0,(now-(Number(currentAction.startedAt)||now-1))/1000);
      if(stateName==='eat'){
        const bite=Math.max(0,actionT-.7);
        dx=-Math.min(8,actionT*8);dy+=Math.sin(bite*17)*2.2;rot=Math.sin(bite*14)*.035;sx=1+.025*Math.sin(bite*20);sy=1-.02*Math.sin(bite*20);
      }else if(stateName==='medicine'){
        if(actionT>.65){dx=Math.sin(actionT*34)*2.7;rot=Math.sin(actionT*28)*.045;dy-=Math.abs(Math.sin(actionT*8))*2}
      }else if(stateName==='clean'){
        dx=Math.sin(actionT*14)*3.5;rot=Math.sin(actionT*12)*.06;dy-=Math.abs(Math.sin(actionT*9))*2;sx=1+.018*Math.sin(actionT*18);sy=1-.018*Math.sin(actionT*18);
      }else if(stateName==='play'){
        const started=Number(currentAction.startedAt)||now-1;playT=Math.max(0,(now-started)/1000);
        const cycle=playT*Math.PI*2;
        if(p.species==='mossbit'){
          // Three springy pounces with small side-to-side movement.
          const hop=Math.abs(Math.sin(playT*Math.PI*2.15));dy-=hop*18;dx=Math.sin(playT*Math.PI*1.45)*11;rot=Math.sin(playT*9)*.09;sx=1+.05*(1-hop);sy=1-.06*(1-hop);
        }else if(p.species==='voltfin'){
          // Fast electric jitter with a pulse.
          dx=Math.sin(playT*42)*5;dy+=Math.cos(playT*33)*2;rot=Math.sin(playT*28)*.055;const pulse=.045*Math.sin(playT*20);sx=1+pulse;sy=1-pulse;
        }else if(p.species==='cinderhorn'){
          // Repeated short bull-like charges and stomps.
          const phase=(playT*.95)%1;dx=(phase<.55?phase/.55:(1-phase)/.45)*34-13;dy-=Math.abs(Math.sin(playT*Math.PI*3))*5;rot=-.08+Math.sin(playT*11)*.035;sx=1.06;sy=.97;
        }else if(p.species==='shellbyte'){
          // A real shell roll: rotate around its center while hopping slightly.
          rot=playT*5.4;dy-=Math.abs(Math.sin(playT*Math.PI*2))*9;dx=Math.sin(playT*3.2)*10;sx=sy=.98;
        }else if(p.species==='noctwing'){
          // Wide floating loop / swoop.
          dx=Math.sin(playT*3.2)*22;dy-=12+Math.sin(playT*6.4)*13;rot=Math.sin(playT*3.2)*.16;sx=1.03;sy=.98;
        }else if(p.species==='ironpup'){
          // Quick dog-like zoomies with bounding hops.
          dx=Math.sin(playT*5.4)*28;dy-=Math.abs(Math.sin(playT*10.8))*10;rot=Math.sin(playT*5.4)*.11;sx=1.04;sy=.98;
        }
      }
      const ox=baseOx+dx,oy=baseOy+dy,cx=baseOx+sw/2+dx,cy=baseOy+sh/2+dy;
      ctx.save();ctx.translate(cx,cy);ctx.rotate(rot);ctx.scale(sx,sy);ctx.translate(-cx,-cy);if(p.dead)ctx.globalAlpha=.45;
      if(def.bitmap){
        for(let y=0;y<def.bitmap.length;y++){const row=def.bitmap[y];for(let x=0;x<row.length;x++){const c=row[x];if(c==='.')continue;ctx.fillStyle=pal[c]||'#fff';ctx.fillRect(Math.round(ox+x*px),Math.round(oy+y*px),px,px)}}
      }else if(def.art){
        for(const [c,x,y,rw,rh] of def.art){ctx.fillStyle=pal[c]||'#fff';ctx.fillRect(Math.round(ox+x*px),Math.round(oy+y*px),rw*px,rh*px)}
      }
      if(stateName==='happy'){ctx.fillStyle='rgba(244,119,157,.88)';ctx.fillRect(Math.round(ox+4*px),Math.round(oy+10*px),px,px);ctx.fillRect(Math.round(ox+13*px),Math.round(oy+10*px),px,px)}
      if(p.sleeping){ctx.fillStyle='rgba(10,10,14,.65)';ctx.fillRect(Math.round(ox+6*px),Math.round(oy+7*px),2*px,px);ctx.fillRect(Math.round(ox+11*px),Math.round(oy+7*px),2*px,px)}
      ctx.restore();
      if(stateName==='play')drawPlayEffects(p.species,playT,ox,oy,sw,sh,px);
      if(stateName==='eat'||stateName==='medicine'||stateName==='clean')drawCareEffects(stateName,p.species,actionT,ox,oy,sw,sh,px);
      if(p.sleeping && !p.dead){
        const z1=Math.max(11,Math.round(px*2.15)), z2=Math.max(9,Math.round(px*1.65)), z3=Math.max(8,Math.round(px*1.25));
        const zx=ox+sw*.70, zy=oy+sh*.18;
        ctx.save();
        ctx.fillStyle='rgba(205,225,212,.72)';
        ctx.textAlign='left';
        ctx.font=`${z1}px monospace`;ctx.fillText('Z',Math.round(zx),Math.round(zy+z1*.72));
        ctx.font=`${z2}px monospace`;ctx.fillText('Z',Math.round(zx+z1*.58),Math.round(zy-z2*.05));
        ctx.font=`${z3}px monospace`;ctx.fillText('Z',Math.round(zx+z1*1.02),Math.round(zy-z3*.6));
        ctx.restore();
      }
      if(p.dead){ctx.fillStyle='rgba(220,230,223,.72)';ctx.font=`${Math.max(11,px*2)}px monospace`;ctx.textAlign='center';ctx.fillText('RIP',Math.round(w/2),Math.max(18,Math.round(oy-8)));ctx.textAlign='start'}else if(p.health<25){ctx.strokeStyle='rgba(213,156,156,.75)';ctx.lineWidth=1;ctx.strokeRect(Math.round(ox-4),Math.round(oy-4),sw+8,sh+8)}
    }
    let lastRender=0,sleepTimer=null;
    const scheduleFrame=(delay=0)=>{
      if(disposed)return;
      if(delay>0){clearTimeout(sleepTimer);sleepTimer=setTimeout(()=>requestAnimationFrame(frame),delay)}
      else requestAnimationFrame(frame);
    };
    function frame(now){
      if(disposed)return;
      if(!visible || document.hidden){scheduleFrame(1000);return}
      if(now-lastFrame>520){frameNo++;lastFrame=now;advance();notify()}
      const actionActive=currentAction?.petId===current?.id && Date.now()<currentAction.until;
      // Idle pets need only ~8 FPS; care/play animations use ~30 FPS.
      const interval=actionActive?33:125;
      if(now-lastRender>=interval){lastRender=now;drawRoom();drawSprite()}
      scheduleFrame();
    }
    resize();scheduleFrame();
    return()=>{disposed=true;clearTimeout(sleepTimer);unsub();ro.disconnect();io.disconnect()}
  }
  return{mount,act,rename,selectPet,changeSpecies,addPet,removePet,resetPet,species};
})();

class TamagotchiWindow{
  constructor(opts={}){
    const node=document.createElement('div');node.className='tamagotchi-window-host';document.querySelector('#window-mounts').appendChild(node);
    const dispose=TamagotchiWidget.mount(node,{docked:false});
    this.window=new ApplicationWindow({title:'Tamagotchi',label:`tamagotchi-${Date.now()}`,x:opts.x,y:opts.y,width:opts.width||'500',height:opts.height||'610',launcher:{name:'TamagotchiWindow',opts:{...opts}},mount:node,onclose:()=>{dispose();node.remove()}});
    if(window.BrowserOSDock)this.window.addControl({index:0,class:'wb-dock',image:'./images/dock.svg',click:(_e,winbox)=>{BrowserOSDock.dock('tamagotchi');winbox.close()}})
  }
}
window.TamagotchiWidget=TamagotchiWidget;
window.TamagotchiWindow=TamagotchiWindow;
