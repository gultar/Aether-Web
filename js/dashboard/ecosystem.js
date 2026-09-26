const EcosystemWidget = (() => {
  const clamp = (v,a,b)=>Math.max(a,Math.min(b,v));
  const rand = (a,b)=>a+Math.random()*(b-a);
  const dist2 = (a,b)=>{const dx=a.x-b.x,dy=a.y-b.y;return dx*dx+dy*dy};

  function mount(host, options={}){
    host.innerHTML = `
      <section class="ecosystem-widget${options.docked ? ' ecosystem-docked' : ''}">
        <div class="eco-stage">
          <canvas class="eco-canvas" aria-label="Tiny ecosystem simulation"></canvas>
          <div class="eco-toolbar" aria-label="Ecosystem controls">
            <button data-brush="grass" title="Paint grass">grass</button>
            <button data-brush="herbivore" title="Spawn herbivore">herb</button>
            <button data-brush="predator" title="Spawn predator">pred</button>
            <button data-brush="erase" title="Erase">erase</button>
            <span></span>
            <button data-action="slower" title="Slower">−</button>
            <button data-action="pause" title="Pause / resume">Ⅱ</button>
            <button data-action="faster" title="Faster">+</button>
            <button data-action="reset" title="Reset ecosystem">↻</button>
          </div>
          <div class="eco-inspector" hidden></div>
        </div>
        <footer class="eco-footer">
          <span data-eco-stat="grass">grass --</span>
          <span data-eco-stat="herbivore">herb --</span>
          <span data-eco-stat="predator">pred --</span>
          <span data-eco-speed>1×</span>
        </footer>
        <canvas class="eco-chart" aria-label="Population history"></canvas>
      </section>`;

    const root=host.querySelector('.ecosystem-widget');
    const canvas=root.querySelector('.eco-canvas');
    const chart=root.querySelector('.eco-chart');
    const inspector=root.querySelector('.eco-inspector');
    const ctx=canvas.getContext('2d');
    const cctx=chart.getContext('2d');
    let w=1,h=1,dpr=1;
    let brush='inspect', paused=false, speed=1, disposed=false, visible=true;
    let selected=null, follow=null, painting=false;
    let last=performance.now(), accumulator=0, chartAccumulator=0;
    let grass=[], herbivores=[], predators=[], history=[];
    let idSeq=0;

    const world={width:640,height:400};
    const makeAnimal=(kind,x=rand(0,world.width),y=rand(0,world.height))=>({
      id:`${kind==='herbivore'?'H':'P'}-${String(++idSeq).padStart(2,'0')}`,
      kind,x,y,vx:rand(-1,1),vy:rand(-1,1),energy:rand(62,92),age:0,children:0,kills:0,
      maxAge: kind==='herbivore'?rand(80,145):rand(105,175), trail:[]
    });
    const makeGrass=(x=rand(0,world.width),y=rand(0,world.height),energy=rand(.5,1))=>({x,y,energy});

    function reset(){
      idSeq=0; selected=null; follow=null; history=[];
      grass=Array.from({length:150},()=>makeGrass());
      herbivores=Array.from({length:18},()=>makeAnimal('herbivore'));
      predators=Array.from({length:4},()=>makeAnimal('predator'));
      updateInspector(); updateStats();
    }

    function resize(){
      const r=canvas.getBoundingClientRect();
      dpr=Math.min(2,window.devicePixelRatio||1); w=Math.max(1,r.width); h=Math.max(1,r.height);
      canvas.width=Math.round(w*dpr); canvas.height=Math.round(h*dpr); ctx.setTransform(dpr,0,0,dpr,0,0);
      const cr=chart.getBoundingClientRect(); chart.width=Math.max(1,Math.round(cr.width*dpr)); chart.height=Math.max(1,Math.round(cr.height*dpr)); cctx.setTransform(dpr,0,0,dpr,0,0);
    }
    const sx=x=>x/world.width*w, sy=y=>y/world.height*h;
    const wx=x=>x/w*world.width, wy=y=>y/h*world.height;

    function nearest(list,a,maxD){let best=null,bd=maxD*maxD;for(const b of list){const d=dist2(a,b);if(d<bd){bd=d;best=b}}return best}
    function steer(a,target,amount=.055){if(!target)return;const dx=target.x-a.x,dy=target.y-a.y,l=Math.hypot(dx,dy)||1;a.vx+=dx/l*amount;a.vy+=dy/l*amount}
    function wander(a,amount=.035){a.vx+=rand(-amount,amount);a.vy+=rand(-amount,amount)}
    function limit(a,max){const l=Math.hypot(a.vx,a.vy);if(l>max){a.vx=a.vx/l*max;a.vy=a.vy/l*max}}
    function move(a,dt){
      a.trail.push({x:a.x,y:a.y,t:performance.now()}); if(a.trail.length>8)a.trail.shift();
      a.x+=a.vx*dt*14; a.y+=a.vy*dt*14;
      if(a.x<0){a.x=0;a.vx=Math.abs(a.vx)} if(a.x>world.width){a.x=world.width;a.vx=-Math.abs(a.vx)}
      if(a.y<0){a.y=0;a.vy=Math.abs(a.vy)} if(a.y>world.height){a.y=world.height;a.vy=-Math.abs(a.vy)}
    }
    function reproduce(list,a,kind,cost){if(a.energy>88 && list.length<(kind==='herbivore'?70:16) && Math.random()<.0035){a.energy-=cost;a.children++;const b=makeAnimal(kind,clamp(a.x+rand(-12,12),0,world.width),clamp(a.y+rand(-12,12),0,world.height));b.energy=55;list.push(b)}}

    function tick(dt){
      // Grass slowly regrows and densifies in under-grazed worlds.
      if(grass.length<230 && Math.random()<(.16 + Math.max(0,80-grass.length)*.004)*dt*10){grass.push(makeGrass())}
      grass.forEach(g=>g.energy=Math.min(1,g.energy+dt*.04));

      for(let i=herbivores.length-1;i>=0;i--){
        const a=herbivores[i]; a.age+=dt; a.energy-=dt*(1.0 + Math.hypot(a.vx,a.vy)*.16);
        const food=nearest(grass,a,a.energy<72?95:45); if(food)steer(a,food,.075); else wander(a);
        const danger=nearest(predators,a,65); if(danger){a.vx+=(a.x-danger.x)*.002;a.vy+=(a.y-danger.y)*.002}
        limit(a,2.3); move(a,dt);
        if(food && dist2(a,food)<64){a.energy=Math.min(100,a.energy+28*food.energy);grass.splice(grass.indexOf(food),1)}
        reproduce(herbivores,a,'herbivore',29);
        if(a.energy<=0||a.age>a.maxAge){if(selected===a)selected=null;if(follow===a)follow=null;herbivores.splice(i,1)}
      }

      for(let i=predators.length-1;i>=0;i--){
        const a=predators[i]; a.age+=dt; a.energy-=dt*(1.25 + Math.hypot(a.vx,a.vy)*.2);
        const prey=nearest(herbivores,a,a.energy<80?150:85); if(prey)steer(a,prey,.095); else wander(a,.045);
        limit(a,2.65); move(a,dt);
        if(prey && dist2(a,prey)<90){const idx=herbivores.indexOf(prey);if(idx>=0){herbivores.splice(idx,1);a.energy=Math.min(100,a.energy+48);a.kills++;if(selected===prey)selected=null;if(follow===prey)follow=null}}
        reproduce(predators,a,'predator',36);
        if(a.energy<=0||a.age>a.maxAge){if(selected===a)selected=null;if(follow===a)follow=null;predators.splice(i,1)}
      }

      // Prevent permanent extinction so the terrarium remains watchable.
      if(herbivores.length===0 && grass.length>80 && Math.random()<.01) herbivores.push(makeAnimal('herbivore'));
      if(predators.length===0 && herbivores.length>20 && Math.random()<.004) predators.push(makeAnimal('predator'));
      updateStats(); if(selected)updateInspector();
    }

    function drawTerrain(){
      ctx.fillStyle='#07100c';ctx.fillRect(0,0,w,h);
      // subdued procedural-looking patches
      ctx.fillStyle='rgba(37,74,54,.12)';
      for(let i=0;i<8;i++){const x=(i*83%world.width),y=(i*137%world.height);ctx.beginPath();ctx.ellipse(sx(x),sy(y),w*.12,h*.09,.2*i,0,Math.PI*2);ctx.fill()}
      ctx.fillStyle='rgba(40,70,84,.10)';ctx.beginPath();ctx.ellipse(w*.78,h*.23,w*.16,h*.09,-.25,0,Math.PI*2);ctx.fill();
    }
    function draw(){
      drawTerrain(); const now=performance.now();
      for(const g of grass){const x=sx(g.x),y=sy(g.y);ctx.strokeStyle=`rgba(109,176,119,${.28+.48*g.energy})`;ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(x,y+2);ctx.lineTo(x-1,y-2);ctx.moveTo(x,y+1);ctx.lineTo(x+2,y-1);ctx.stroke()}
      const drawAnimal=(a,pred=false)=>{
        for(let i=0;i<a.trail.length;i++){const t=a.trail[i],alpha=(i+1)/a.trail.length*.13;ctx.fillStyle=pred?`rgba(218,120,104,${alpha})`:`rgba(157,205,173,${alpha})`;ctx.beginPath();ctx.arc(sx(t.x),sy(t.y),1.2,0,Math.PI*2);ctx.fill()}
        const x=sx(a.x),y=sy(a.y),ang=Math.atan2(a.vy,a.vx),r=pred?4.2:3.5;
        ctx.save();ctx.translate(x,y);ctx.rotate(ang);ctx.fillStyle=pred?'rgba(220,127,105,.92)':(a.energy<25?'rgba(143,162,148,.72)':'rgba(171,215,184,.92)');ctx.beginPath();ctx.moveTo(r,0);ctx.lineTo(-r*.75,-r*.62);ctx.lineTo(-r*.45,0);ctx.lineTo(-r*.75,r*.62);ctx.closePath();ctx.fill();ctx.restore();
        if(selected===a||follow===a){ctx.strokeStyle=follow===a?'rgba(206,230,215,.95)':'rgba(206,230,215,.55)';ctx.lineWidth=1;ctx.beginPath();ctx.arc(x,y,r+4,0,Math.PI*2);ctx.stroke()}
      };
      herbivores.forEach(a=>drawAnimal(a,false));predators.forEach(a=>drawAnimal(a,true));
      if(follow && (herbivores.includes(follow)||predators.includes(follow))){ctx.strokeStyle='rgba(220,235,225,.22)';ctx.beginPath();ctx.moveTo(sx(follow.x)-10,sy(follow.y));ctx.lineTo(sx(follow.x)+10,sy(follow.y));ctx.moveTo(sx(follow.x),sy(follow.y)-10);ctx.lineTo(sx(follow.x),sy(follow.y)+10);ctx.stroke()}
    }

    function drawChart(){
      const cw=chart.width/dpr,ch=chart.height/dpr;cctx.clearRect(0,0,cw,ch);if(history.length<2)return;
      const max=Math.max(10,...history.flatMap(x=>[x.g,x.h,x.p*4]));
      const line=(key,scale,alpha)=>{cctx.strokeStyle=`rgba(188,214,196,${alpha})`;cctx.lineWidth=1;cctx.beginPath();history.forEach((v,i)=>{const x=i/(history.length-1)*cw,y=ch-(v[key]*scale/max)*(ch-3)-1;i?cctx.lineTo(x,y):cctx.moveTo(x,y)});cctx.stroke()};
      line('g',1,.28);line('h',1,.75);line('p',4,.5);
    }

    function updateStats(){
      root.querySelector('[data-eco-stat="grass"]').textContent=`grass ${grass.length}`;
      root.querySelector('[data-eco-stat="herbivore"]').textContent=`herb ${herbivores.length}`;
      root.querySelector('[data-eco-stat="predator"]').textContent=`pred ${predators.length}`;
      root.querySelector('[data-eco-speed]').textContent=`${speed}×`;
    }
    function updateInspector(){
      if(!selected){inspector.hidden=true;return} inspector.hidden=false;
      const alive=herbivores.includes(selected)||predators.includes(selected);if(!alive){selected=null;inspector.hidden=true;return}
      inspector.innerHTML=`<strong>${selected.id}</strong><span>age ${Math.floor(selected.age)}</span><span>energy ${Math.max(0,Math.round(selected.energy))}%</span><span>children ${selected.children}</span>${selected.kind==='predator'?`<span>kills ${selected.kills}</span>`:''}${follow===selected?'<em>FOLLOW</em>':''}`;
    }
    function pick(x,y){const p={x:wx(x),y:wy(y)};return nearest([...herbivores,...predators],p,18)}
    function applyBrush(e){
      const r=canvas.getBoundingClientRect(),x=e.clientX-r.left,y=e.clientY-r.top,X=wx(x),Y=wy(y);
      if(brush==='grass'){for(let i=0;i<5;i++)grass.push(makeGrass(clamp(X+rand(-16,16),0,world.width),clamp(Y+rand(-12,12),0,world.height),1))}
      else if(brush==='herbivore')herbivores.push(makeAnimal('herbivore',X,Y));
      else if(brush==='predator')predators.push(makeAnimal('predator',X,Y));
      else if(brush==='erase'){
        const a=pick(x,y);if(a){const arr=a.kind==='predator'?predators:herbivores;arr.splice(arr.indexOf(a),1)}
        else {const g=nearest(grass,{x:X,y:Y},22);if(g)grass.splice(grass.indexOf(g),1)}
      } else {selected=pick(x,y);updateInspector()}
      updateStats();
    }

    canvas.addEventListener('pointerdown',e=>{painting=true;canvas.setPointerCapture(e.pointerId);applyBrush(e)});
    canvas.addEventListener('pointermove',e=>{if(painting && ['grass','erase'].includes(brush))applyBrush(e)});
    canvas.addEventListener('pointerup',e=>{painting=false;try{canvas.releasePointerCapture(e.pointerId)}catch(_){}});
    canvas.addEventListener('dblclick',e=>{const r=canvas.getBoundingClientRect(),a=pick(e.clientX-r.left,e.clientY-r.top);if(a){selected=a;follow=(follow===a?null:a);updateInspector()}});
    canvas.addEventListener('contextmenu',e=>{e.preventDefault();const old=brush;brush='erase';applyBrush(e);brush=old});

    root.querySelectorAll('[data-brush]').forEach(b=>b.addEventListener('click',()=>{root.querySelectorAll('[data-brush]').forEach(x=>x.classList.remove('active'));if(brush===b.dataset.brush){brush='inspect'}else{brush=b.dataset.brush;b.classList.add('active')}}));
    root.querySelector('[data-action="pause"]').addEventListener('click',e=>{paused=!paused;e.currentTarget.textContent=paused?'▶':'Ⅱ'});
    root.querySelector('[data-action="slower"]').addEventListener('click',()=>{speed=Math.max(.25,speed/2);updateStats()});
    root.querySelector('[data-action="faster"]').addEventListener('click',()=>{speed=Math.min(4,speed*2);updateStats()});
    root.querySelector('[data-action="reset"]').addEventListener('click',reset);

    const ro=new ResizeObserver(()=>resize());ro.observe(root);
    const io=new IntersectionObserver(entries=>{visible=entries.some(e=>e.isIntersecting)},{threshold:.01});io.observe(root);
    const vis=()=>{}; document.addEventListener('visibilitychange',vis);

    let lastRender=0, sleepTimer=null;
    const scheduleFrame=(delay=0)=>{
      if(disposed)return;
      if(delay>0){clearTimeout(sleepTimer);sleepTimer=setTimeout(()=>requestAnimationFrame(frame),delay)}
      else requestAnimationFrame(frame);
    };
    function frame(now){
      if(disposed)return;
      if(!visible || document.hidden){last=now;scheduleFrame(750);return}
      // The ecosystem is ambient UI, not a game. Cap rendering at ~20 FPS.
      if(now-lastRender<50){scheduleFrame();return}
      const raw=Math.min(.10,(now-last)/1000);last=now;lastRender=now;
      if(!paused){accumulator+=raw*speed;chartAccumulator+=raw*speed;let guard=0;while(accumulator>=.05 && guard++<4){tick(.05);accumulator-=.05}if(chartAccumulator>=1.2){history.push({g:grass.length,h:herbivores.length,p:predators.length});if(history.length>90)history.shift();chartAccumulator=0}}
      draw();drawChart();scheduleFrame();
    }
    reset();resize();scheduleFrame();

    return ()=>{disposed=true;clearTimeout(sleepTimer);ro.disconnect();io.disconnect();document.removeEventListener('visibilitychange',vis)};
  }
  return {mount};
})();

class EcosystemWindow {
  constructor(opts={}){
    const node=document.createElement('div');node.className='ecosystem-window-host';document.querySelector('#window-mounts').appendChild(node);
    const dispose=EcosystemWidget.mount(node,{docked:false});
    this.window=new ApplicationWindow({
      title:'Ecosystem',label:`ecosystem-${Date.now()}`,
      x:opts.x,y:opts.y,width:opts.width||'620',height:opts.height||'470',
      launcher:{name:'EcosystemWindow',opts:{...opts}},mount:node,
      onclose:()=>{dispose();node.remove()}
    });
    if(window.BrowserOSDock){this.window.addControl({index:0,class:'wb-dock',image:'./images/dock.svg',click:(_event,winbox)=>{BrowserOSDock.dock('ecosystem');winbox.close()}})}
  }
}
window.EcosystemWidget=EcosystemWidget;
window.EcosystemWindow=EcosystemWindow;
