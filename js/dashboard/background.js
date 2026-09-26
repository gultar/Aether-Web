(function(){
  const CONFIG_KEY = 'browser-os-background-config-v2';
  const LEGACY_KEY = 'browser-os-background';
  const DB_NAME = 'browser-os';
  const DB_VERSION = 1;
  const STORE = 'wallpapers';
  const IMAGE_KEY = 'desktop-wallpaper';
  const IMAGE_SET_KEY = 'desktop-wallpapers-v2';

  let objectUrls = [];
  let cycleTimer = null;
  let fadeTimer = null;
  let cycleIndex = 0;
  let fadeLayer = null;

  const presets = {
    midnight: {
      name: 'Midnight',
      css: 'radial-gradient(circle at 75% 20%, rgba(45,89,126,.42), transparent 35%), radial-gradient(circle at 20% 80%, rgba(33,62,95,.36), transparent 38%), linear-gradient(135deg, #07111c 0%, #0d1a29 48%, #06090e 100%)'
    },
    slate: {
      name: 'Slate',
      css: 'linear-gradient(135deg, #18212c 0%, #0e151d 52%, #080c11 100%)'
    },
    dusk: {
      name: 'Dusk',
      css: 'radial-gradient(circle at 80% 15%, rgba(117,83,150,.38), transparent 36%), linear-gradient(145deg, #171525 0%, #101724 52%, #070a10 100%)'
    },
    forest: {
      name: 'Forest',
      css: 'radial-gradient(circle at 20% 20%, rgba(62,116,91,.32), transparent 38%), linear-gradient(140deg, #0b1915 0%, #0d1618 52%, #070a0d 100%)'
    }
  };

  function defaultConfig(){
    return {
      mode:'gradient',
      preset:'midnight',
      color1:'#07111c',
      color2:'#0d1a29',
      angle:135,
      flat:'#0b1119',
      url:'',
      cycleSeconds:60,
      fadeSeconds:2.5
    };
  }

  function getConfig(){
    try {
      const parsed = JSON.parse(localStorage.getItem(CONFIG_KEY));
      return {...defaultConfig(), ...(parsed || {})};
    } catch { return defaultConfig(); }
  }

  function saveConfig(config){ localStorage.setItem(CONFIG_KEY, JSON.stringify(config)); }

  function openDb(){
    return new Promise((resolve,reject)=>{
      const req=indexedDB.open(DB_NAME,DB_VERSION);
      req.onupgradeneeded=()=>{ if(!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE); };
      req.onsuccess=()=>resolve(req.result);
      req.onerror=()=>reject(req.error);
    });
  }

  async function putImages(files){
    const images=[...files].filter(file=>file && file.type && file.type.startsWith('image/'));
    if(!images.length) throw new Error('Please select one or more image files.');

    const payload={
      items:images.map(file=>({
        blob:file,
        name:file.name || 'wallpaper',
        type:file.type || '',
        lastModified:Number(file.lastModified)||0
      }))
    };

    const db=await openDb();
    await new Promise((resolve,reject)=>{
      const tx=db.transaction(STORE,'readwrite');
      tx.objectStore(STORE).put(payload,IMAGE_SET_KEY);
      // Keep the legacy single-image slot populated for backwards compatibility.
      tx.objectStore(STORE).put(images[0],IMAGE_KEY);
      tx.oncomplete=resolve;
      tx.onerror=()=>reject(tx.error);
    });
    db.close();
    return images.length;
  }

  async function getImages(){
    const db=await openDb();
    const value=await new Promise((resolve,reject)=>{
      const tx=db.transaction(STORE,'readonly');
      const store=tx.objectStore(STORE);
      const setReq=store.get(IMAGE_SET_KEY);
      setReq.onsuccess=()=>{
        const set=setReq.result;
        if(set && Array.isArray(set.items) && set.items.length){
          resolve(set.items.map((item,index)=>({
            blob:item?.blob instanceof Blob ? item.blob : item,
            name:item?.name || `Wallpaper ${index+1}`
          })).filter(item=>item.blob instanceof Blob));
          return;
        }
        const legacyReq=store.get(IMAGE_KEY);
        legacyReq.onsuccess=()=>resolve(legacyReq.result instanceof Blob ? [{blob:legacyReq.result,name:'Wallpaper'}] : []);
        legacyReq.onerror=()=>reject(legacyReq.error);
      };
      setReq.onerror=()=>reject(setReq.error);
    });
    db.close();
    return value;
  }

  async function saveImages(items){
    const images=[...(items || [])].filter(item=>item?.blob instanceof Blob);
    const db=await openDb();
    await new Promise((resolve,reject)=>{
      const tx=db.transaction(STORE,'readwrite');
      const store=tx.objectStore(STORE);
      if(images.length){
        store.put({
          items:images.map((item,index)=>({
            blob:item.blob,
            name:item.name || `Wallpaper ${index+1}`,
            type:item.type || item.blob.type || '',
            lastModified:Number(item.lastModified)||0
          }))
        },IMAGE_SET_KEY);
        // Keep the old single-image slot pointing at the first remaining image.
        store.put(images[0].blob,IMAGE_KEY);
      }else{
        store.delete(IMAGE_SET_KEY);
        store.delete(IMAGE_KEY);
      }
      tx.oncomplete=resolve;
      tx.onerror=()=>reject(tx.error);
    });
    db.close();
    return images.length;
  }

  async function removeImageAt(index){
    const images=await getImages();
    const target=Number(index);
    if(!Number.isInteger(target) || target<0 || target>=images.length) return images.length;
    images.splice(target,1);
    const count=await saveImages(images);
    const cfg=getConfig();
    if(cfg.mode==='local') await apply(cfg);
    return count;
  }

  async function deleteImages(){
    await saveImages([]);
  }

  function clearObjectUrls(){
    objectUrls.forEach(url=>URL.revokeObjectURL(url));
    objectUrls=[];
  }

  function stopCycle(){
    if(cycleTimer){ clearInterval(cycleTimer); cycleTimer=null; }
    if(fadeTimer){ clearTimeout(fadeTimer); fadeTimer=null; }
    cycleIndex=0;
    if(fadeLayer){
      fadeLayer.style.transition='none';
      fadeLayer.style.opacity='0';
      fadeLayer.style.background='transparent';
    }
  }

  function ensureFadeLayer(){
    if(fadeLayer && fadeLayer.isConnected) return fadeLayer;
    fadeLayer=document.createElement('div');
    fadeLayer.id='browseros-wallpaper-fade-layer';
    fadeLayer.setAttribute('aria-hidden','true');
    document.body.insertBefore(fadeLayer,document.body.firstChild);
    return fadeLayer;
  }

  function setBody(css, size='cover'){
    document.body.style.background = css;
    document.body.style.backgroundSize = size;
    document.body.style.backgroundPosition = 'center';
    document.body.style.backgroundRepeat = 'no-repeat';
    document.body.style.backgroundAttachment = 'fixed';
  }

  function imageCss(url){
    return `linear-gradient(rgba(5,8,14,.10), rgba(5,8,14,.20)), url("${url}")`;
  }

  function setLayerImage(layer,url){
    layer.style.background=imageCss(url);
    layer.style.backgroundSize='cover';
    layer.style.backgroundPosition='center';
    layer.style.backgroundRepeat='no-repeat';
  }

  function crossfadeTo(url,fadeSeconds){
    const layer=ensureFadeLayer();
    const seconds=Math.max(0.1,Math.min(10,Number(fadeSeconds)||2.5));
    if(fadeTimer){ clearTimeout(fadeTimer); fadeTimer=null; }

    layer.style.transition='none';
    layer.style.opacity='0';
    setLayerImage(layer,url);
    // Force the initial opacity to be committed before enabling the transition.
    void layer.offsetWidth;
    layer.style.transition=`opacity ${seconds}s ease-in-out`;
    layer.style.opacity='1';

    fadeTimer=setTimeout(()=>{
      setBody(imageCss(url));
      layer.style.transition='none';
      layer.style.opacity='0';
      layer.style.background='transparent';
      fadeTimer=null;
    },Math.round(seconds*1000)+40);
  }

  async function apply(config=getConfig()){
    stopCycle();
    clearObjectUrls();

    if(config.mode==='flat'){
      setBody(config.flat || '#0b1119', 'auto');
    } else if(config.mode==='url' && config.url){
      const safe=String(config.url).replace(/["\\\n\r]/g,'');
      setBody(`linear-gradient(rgba(5,8,14,.16), rgba(5,8,14,.28)), url("${safe}")`);
    } else if(config.mode==='local'){
      try{
        const images=await getImages();
        if(images.length){
          objectUrls=images.map(item=>URL.createObjectURL(item.blob));
          cycleIndex=0;
          setBody(imageCss(objectUrls[0]));

          if(objectUrls.length>1){
            const fadeSeconds=Math.max(0.1,Math.min(10,Number(config.fadeSeconds)||2.5));
            const cycleSeconds=Math.max(5,fadeSeconds+1,Number(config.cycleSeconds)||60);
            cycleTimer=setInterval(()=>{
              cycleIndex=(cycleIndex+1)%objectUrls.length;
              crossfadeTo(objectUrls[cycleIndex],fadeSeconds);
            },Math.round(cycleSeconds*1000));
          }
          return;
        }
      }catch(e){ console.warn('Wallpaper load failed:',e); }
      setBody(presets.midnight.css);
    } else if(config.mode==='custom-gradient'){
      const angle=Math.max(0,Math.min(360,Number(config.angle)||135));
      setBody(`linear-gradient(${angle}deg, ${config.color1 || '#07111c'}, ${config.color2 || '#0d1a29'})`);
    } else {
      setBody((presets[config.preset] || presets.midnight).css);
    }
  }

  async function setLocalFiles(files){
    const list=[...files];
    if(!list.length) throw new Error('Please select one or more image files.');
    const invalid=list.find(file=>!file.type.startsWith('image/'));
    if(invalid) throw new Error(`${invalid.name || 'A selected file'} is not an image.`);

    await putImages(list);
    const cfg={...getConfig(),mode:'local'};
    saveConfig(cfg);
    await apply(cfg);
    return {...cfg,imageCount:list.length};
  }

  async function setLocalFile(file){ return setLocalFiles(file ? [file] : []); }

  async function reset(){
    await deleteImages().catch(()=>{});
    localStorage.removeItem(LEGACY_KEY);
    const cfg=defaultConfig();
    saveConfig(cfg);
    await apply(cfg);
    return cfg;
  }

  async function migrateLegacy(){
    if(localStorage.getItem(CONFIG_KEY)) return;
    const legacy=localStorage.getItem(LEGACY_KEY);
    if(legacy){ const cfg={...defaultConfig(),mode:'url',url:legacy}; saveConfig(cfg); }
    else saveConfig(defaultConfig());
  }

  class BackgroundWindow {
    constructor(opts={}){
      const node=document.querySelector('#background-template').content.firstElementChild.cloneNode(true);
      document.querySelector('#window-mounts').appendChild(node);
      const mode=node.querySelector('.background-mode');
      const panels=[...node.querySelectorAll('[data-bg-panel]')];
      const status=node.querySelector('.background-status');
      const preview=node.querySelector('.background-preview');
      const localCount=node.querySelector('.bg-local-count');
      const localList=node.querySelector('.bg-local-list');
      let cfg=getConfig();

      const showPanel=()=>panels.forEach(p=>p.hidden=p.dataset.bgPanel!==mode.value);

      const updateLocalCount=async()=>{
        if(!localCount) return;
        try{
          const images=await getImages();
          localCount.textContent=images.length ? `${images.length} image${images.length===1?'':'s'} saved` : 'No local images saved';
        }catch{
          localCount.textContent='Local image status unavailable';
        }
      };

      const renderLocalList=async()=>{
        if(!localList) return;
        localList.replaceChildren();
        try{
          const images=await getImages();
          if(!images.length){
            const empty=document.createElement('div');
            empty.className='bg-local-empty';
            empty.textContent='No selected images.';
            localList.appendChild(empty);
            return;
          }

          images.forEach((item,index)=>{
            const row=document.createElement('div');
            row.className='bg-local-item';

            const thumb=document.createElement('img');
            thumb.className='bg-local-thumb';
            thumb.alt='';
            const thumbUrl=URL.createObjectURL(item.blob);
            thumb.src=thumbUrl;
            const release=()=>URL.revokeObjectURL(thumbUrl);
            thumb.addEventListener('load',release,{once:true});
            thumb.addEventListener('error',release,{once:true});

            const name=document.createElement('span');
            name.className='bg-local-name';
            name.textContent=item.name || `Wallpaper ${index+1}`;
            name.title=name.textContent;

            const remove=document.createElement('button');
            remove.type='button';
            remove.className='bg-local-remove';
            remove.textContent='Remove';
            remove.title=`Remove ${name.textContent}`;
            remove.onclick=async()=>{
              remove.disabled=true;
              status.textContent=`Removing ${name.textContent}…`;
              try{
                const remaining=await removeImageAt(index);
                status.textContent=remaining
                  ? `Removed ${name.textContent} — ${remaining} image${remaining===1?'':'s'} remaining`
                  : 'Removed last local image.';
                await updateLocalCount();
                await renderLocalList();
                await updatePreview();
              }catch(err){
                status.textContent=err?.message || 'Could not remove image.';
                remove.disabled=false;
              }
            };

            row.append(thumb,name,remove);
            localList.appendChild(row);
          });
        }catch{
          const error=document.createElement('div');
          error.className='bg-local-empty';
          error.textContent='Selected image list unavailable.';
          localList.appendChild(error);
        }
      };

      const reflect=()=>{
        mode.value=cfg.mode;
        node.querySelector('.bg-preset').value=cfg.preset || 'midnight';
        node.querySelector('.bg-flat').value=cfg.flat || '#0b1119';
        node.querySelector('.bg-url').value=cfg.url || '';
        node.querySelector('.bg-color1').value=cfg.color1 || '#07111c';
        node.querySelector('.bg-color2').value=cfg.color2 || '#0d1a29';
        node.querySelector('.bg-angle').value=cfg.angle || 135;
        node.querySelector('.bg-cycle-seconds').value=Math.max(5,Number(cfg.cycleSeconds)||60);
        node.querySelector('.bg-fade-seconds').value=Math.max(0.1,Number(cfg.fadeSeconds)||2.5);
        showPanel();
        updatePreview();
        updateLocalCount();
        renderLocalList();
      };

      const updatePreview=async()=>{
        preview.style.background='';
        preview.style.backgroundSize='contain';
        preview.style.backgroundPosition='center';
        preview.style.backgroundRepeat='no-repeat';
        if(mode.value==='flat'){
          preview.style.background=node.querySelector('.bg-flat').value;
        } else if(mode.value==='url' && node.querySelector('.bg-url').value.trim()){
          const safe=node.querySelector('.bg-url').value.trim().replace(/["\\\n\r]/g,'');
          preview.style.backgroundImage=`url("${safe}")`;
        } else if(mode.value==='custom-gradient'){
          preview.style.background=`linear-gradient(${node.querySelector('.bg-angle').value||135}deg, ${node.querySelector('.bg-color1').value}, ${node.querySelector('.bg-color2').value})`;
        } else if(mode.value==='gradient'){
          preview.style.background=(presets[node.querySelector('.bg-preset').value]||presets.midnight).css;
        } else if(mode.value==='local'){
          try{
            const images=await getImages();
            if(images.length){
              const u=URL.createObjectURL(images[0].blob);
              preview.style.backgroundImage=`url("${u}")`;
              setTimeout(()=>URL.revokeObjectURL(u),1000);
            }
          }catch{}
        }
      };

      mode.onchange=()=>{showPanel();updatePreview();};
      node.querySelectorAll('.bg-preset,.bg-flat,.bg-url,.bg-color1,.bg-color2,.bg-angle').forEach(x=>x.addEventListener('input',updatePreview));

      node.querySelector('.bg-file').onchange=async e=>{
        const selected=[...(e.target.files || [])];
        if(!selected.length) return;
        status.textContent=`Saving ${selected.length} wallpaper${selected.length===1?'':'s'}…`;
        try{
          cfg={
            ...cfg,
            cycleSeconds:Math.max(5,Number(node.querySelector('.bg-cycle-seconds').value)||60),
            fadeSeconds:Math.max(0.1,Math.min(10,Number(node.querySelector('.bg-fade-seconds').value)||2.5))
          };
          saveConfig(cfg);
          cfg=await setLocalFiles(selected);
          status.textContent=selected.length>1 ? `Saved ${selected.length} wallpapers — cycling enabled` : `Saved ${selected[0].name}`;
          reflect();
        } catch(err){ status.textContent=err.message; }
        finally{ e.target.value=''; }
      };

      node.querySelector('.background-apply').onclick=async()=>{
        cfg={
          ...cfg,
          mode:mode.value,
          preset:node.querySelector('.bg-preset').value,
          flat:node.querySelector('.bg-flat').value,
          url:node.querySelector('.bg-url').value.trim(),
          color1:node.querySelector('.bg-color1').value,
          color2:node.querySelector('.bg-color2').value,
          angle:Number(node.querySelector('.bg-angle').value)||135,
          cycleSeconds:Math.max(5,Number(node.querySelector('.bg-cycle-seconds').value)||60),
          fadeSeconds:Math.max(0.1,Math.min(10,Number(node.querySelector('.bg-fade-seconds').value)||2.5))
        };

        if(cfg.mode==='local'){
          const images=await getImages().catch(()=>[]);
          if(!images.length){ status.textContent='Choose one or more local images first.'; return; }
        }
        if(cfg.mode==='url' && cfg.url && !/^https?:\/\//i.test(cfg.url)){
          status.textContent='Wallpaper URL must start with http:// or https://';
          return;
        }
        saveConfig(cfg);
        await apply(cfg);
        status.textContent=cfg.mode==='local' ? 'Background rotation saved.' : 'Background saved.';
        updateLocalCount();
        renderLocalList();
      };

      node.querySelector('.background-reset').onclick=async()=>{
        cfg=await reset();
        status.textContent='Restored default gradient.';
        reflect();
      };

      reflect();
      this.window=new ApplicationWindow({
        title:'Background',
        label:`background-${Date.now()}`,
        x:opts.x,
        y:opts.y,
        width:opts.width||'600',
        height:opts.height||'560',
        launcher:{name:'BackgroundWindow',opts:{...opts}},
        mount:node,
        onclose:()=>node.remove()
      });
    }
  }

  window.BackgroundManager={presets,getConfig,saveConfig,apply,setLocalFile,setLocalFiles,getImages,removeImageAt,reset,migrateLegacy};
  window.BackgroundWindow=BackgroundWindow;
})();
