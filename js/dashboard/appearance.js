(function(){
  const KEY='browser-os-window-appearance-v1';
  const PERF_KEY='browser-os-performance-mode';
  const presets={
    crystal:{label:'Crystal',tint:'#0d1b28',headerOpacity:.42,bodyOpacity:.28,terminalOpacity:.18,controlOpacity:.44,borderOpacity:.18,blur:7,saturation:140,radius:0,shadow:.30},
    smoke:{label:'Smoke',tint:'#171a20',headerOpacity:.64,bodyOpacity:.46,terminalOpacity:.35,controlOpacity:.58,borderOpacity:.13,blur:5,saturation:105,radius:4,shadow:.42},
    ice:{label:'Ice',tint:'#163044',headerOpacity:.42,bodyOpacity:.25,terminalOpacity:.17,controlOpacity:.40,borderOpacity:.28,blur:10,saturation:155,radius:7,shadow:.25},
    violet:{label:'Violet',tint:'#251936',headerOpacity:.48,bodyOpacity:.31,terminalOpacity:.20,controlOpacity:.45,borderOpacity:.22,blur:8,saturation:145,radius:8,shadow:.34},
    amber:{label:'Amber',tint:'#38240d',headerOpacity:.52,bodyOpacity:.33,terminalOpacity:.21,controlOpacity:.48,borderOpacity:.24,blur:6,saturation:135,radius:3,shadow:.36},
    phosphor:{label:'Phosphor',tint:'#071b11',headerOpacity:.65,bodyOpacity:.43,terminalOpacity:.31,controlOpacity:.54,borderOpacity:.20,blur:2,saturation:120,radius:0,shadow:.40},
    flat:{label:'Flat',tint:'#111923',headerOpacity:.96,bodyOpacity:.93,terminalOpacity:.92,controlOpacity:.90,borderOpacity:.16,blur:0,saturation:100,radius:2,shadow:.22}
  };
  const defaults=()=>({...presets.crystal,preset:'crystal'});
  function hexRgb(hex){
    const h=String(hex||'#0d1b28').replace('#','');
    const n=parseInt(h.length===3?h.split('').map(x=>x+x).join(''):h,16);
    return Number.isFinite(n)?[(n>>16)&255,(n>>8)&255,n&255]:[13,27,40];
  }
  function load(){try{return{...defaults(),...(JSON.parse(localStorage.getItem(KEY)||'null')||{})}}catch{return defaults()}}
  function save(cfg){localStorage.setItem(KEY,JSON.stringify(cfg))}
  function rgba(rgb,a){return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${Math.max(0,Math.min(1,Number(a)||0))})`}
  function apply(cfg=load(),persist=false){
    const root=document.documentElement,rgb=hexRgb(cfg.tint);
    root.style.setProperty('--crystal-header',rgba(rgb,cfg.headerOpacity));
    root.style.setProperty('--crystal-body',rgba(rgb,cfg.bodyOpacity));
    root.style.setProperty('--crystal-terminal-body',rgba(rgb,cfg.terminalOpacity));
    root.style.setProperty('--crystal-control',rgba(rgb,cfg.controlOpacity));
    root.style.setProperty('--crystal-border',`rgba(255,255,255,${Math.max(0,Math.min(1,Number(cfg.borderOpacity)||0))})`);
    root.style.setProperty('--crystal-blur',`${Math.max(0,Math.min(30,Number(cfg.blur)||0))}px`);
    root.style.setProperty('--crystal-saturation',`${Math.max(50,Math.min(220,Number(cfg.saturation)||100))}%`);
    root.style.setProperty('--crystal-radius',`${Math.max(0,Math.min(24,Number(cfg.radius)||0))}px`);
    root.style.setProperty('--crystal-shadow-alpha',String(Math.max(0,Math.min(.8,Number(cfg.shadow)||0))));
    if(persist)save(cfg);
    window.dispatchEvent(new CustomEvent('browser-os-appearance-change',{detail:cfg}));
    return cfg;
  }
  function setPerformance(enabled){
    document.body.classList.toggle('performance-mode',!!enabled);
    localStorage.setItem(PERF_KEY,enabled?'1':'0');
    const btn=document.querySelector('[data-action="performance"]');
    if(btn)btn.textContent=`Performance mode: ${enabled?'ON':'OFF'}`;
  }
  function reset(){const cfg=defaults();save(cfg);apply(cfg);return cfg}
  function preset(name){const p=presets[name]||presets.crystal;return{...p,preset:name in presets?name:'crystal'}}

  class AppearanceWindow{
    constructor(opts={}){
      const node=document.createElement('section');node.className='tool appearance-tool';
      node.innerHTML=`
        <header class="tool-head"><span>Window appearance</span><small class="appearance-status">Live preview · saved locally</small></header>
        <div class="appearance-layout">
          <div class="appearance-controls">
            <label><span>Theme</span><select class="appearance-preset">${Object.entries(presets).map(([k,v])=>`<option value="${k}">${v.label}</option>`).join('')}<option value="custom">Custom</option></select></label>
            <label><span>Tint</span><input class="appearance-tint" type="color"></label>
            <div class="appearance-slider"><label><span>Window transparency</span><output data-out="bodyOpacity"></output></label><input data-key="bodyOpacity" type="range" min="0.05" max="1" step="0.01"></div>
            <div class="appearance-slider"><label><span>Header opacity</span><output data-out="headerOpacity"></output></label><input data-key="headerOpacity" type="range" min="0.05" max="1" step="0.01"></div>
            <div class="appearance-slider"><label><span>Control opacity</span><output data-out="controlOpacity"></output></label><input data-key="controlOpacity" type="range" min="0.05" max="1" step="0.01"></div>
            <div class="appearance-slider"><label><span>Terminal opacity</span><output data-out="terminalOpacity"></output></label><input data-key="terminalOpacity" type="range" min="0.03" max="1" step="0.01"></div>
            <div class="appearance-slider"><label><span>Blur</span><output data-out="blur"></output></label><input data-key="blur" type="range" min="0" max="24" step="1"></div>
            <div class="appearance-slider"><label><span>Saturation</span><output data-out="saturation"></output></label><input data-key="saturation" type="range" min="50" max="200" step="5"></div>
            <div class="appearance-slider"><label><span>Border</span><output data-out="borderOpacity"></output></label><input data-key="borderOpacity" type="range" min="0" max="0.6" step="0.01"></div>
            <div class="appearance-slider"><label><span>Corner radius</span><output data-out="radius"></output></label><input data-key="radius" type="range" min="0" max="20" step="1"></div>
            <div class="appearance-slider"><label><span>Shadow</span><output data-out="shadow"></output></label><input data-key="shadow" type="range" min="0" max="0.7" step="0.01"></div>
            <label class="appearance-perf"><span><b>Performance mode</b><small>Disables backdrop blur; transparency remains.</small></span><input class="appearance-performance" type="checkbox"></label>
            <div class="appearance-actions"><button class="appearance-save">Save</button><button class="appearance-reset">Defaults</button></div>
          </div>
          <div class="appearance-preview"><div class="appearance-demo-window"><div class="appearance-demo-head">Preview <span>— □ ×</span></div><div class="appearance-demo-body"><strong>Browser-OS</strong><p>Window tint, transparency and blur update live.</p><button>Control</button></div></div></div>
        </div>`;
      document.querySelector('#window-mounts').appendChild(node);
      let cfg=load();
      const presetSel=node.querySelector('.appearance-preset'),tint=node.querySelector('.appearance-tint'),perf=node.querySelector('.appearance-performance'),status=node.querySelector('.appearance-status');
      const sliders=[...node.querySelectorAll('[data-key]')];
      const format=(key,v)=>['bodyOpacity','headerOpacity','controlOpacity','terminalOpacity','borderOpacity','shadow'].includes(key)?`${Math.round(v*100)}%`:key==='blur'||key==='radius'?`${Math.round(v)}px`:`${Math.round(v)}%`;
      const reflect=()=>{
        presetSel.value=presets[cfg.preset]?cfg.preset:'custom';tint.value=cfg.tint||'#0d1b28';perf.checked=document.body.classList.contains('performance-mode');
        sliders.forEach(s=>{const k=s.dataset.key;s.value=cfg[k];const o=node.querySelector(`[data-out="${k}"]`);if(o)o.value=o.textContent=format(k,Number(cfg[k]))});
      };
      const live=()=>{cfg.preset='custom';apply(cfg,false);status.textContent='Live preview · not saved';reflect()};
      presetSel.onchange=()=>{if(presetSel.value==='custom')return;cfg=preset(presetSel.value);apply(cfg,false);reflect();status.textContent='Preset preview · not saved'};
      tint.oninput=()=>{cfg.tint=tint.value;live()};
      sliders.forEach(s=>s.oninput=()=>{cfg[s.dataset.key]=Number(s.value);live()});
      perf.onchange=()=>setPerformance(perf.checked);
      node.querySelector('.appearance-save').onclick=()=>{save(cfg);apply(cfg);status.textContent='Saved';};
      node.querySelector('.appearance-reset').onclick=()=>{cfg=reset();setPerformance(true);reflect();status.textContent='Defaults restored';};
      reflect();
      this.window=new ApplicationWindow({title:'Window Appearance',label:`appearance-${Date.now()}`,x:opts.x,y:opts.y,width:opts.width||'720',height:opts.height||'610',launcher:{name:'AppearanceWindow',opts:{...opts}},mount:node,onclose:()=>node.remove()});
    }
  }
  const init=()=>apply(load());
  window.WindowAppearanceManager={presets,load,save,apply,reset,preset,setPerformance,init};
  window.AppearanceWindow=AppearanceWindow;
})();
