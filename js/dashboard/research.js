(function(){
  function esc(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}

  async function streamResearch(query, onEvent, sources=4){
    const text=String(query||'').trim();
    if(!text) throw new Error('Enter a research question.');
    const r=await fetch('/api/research/stream',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({query:text,sources:Math.max(3,Math.min(5,Number(sources)||4))})
    });
    if(!r.ok || !r.body){
      const d=await r.json().catch(()=>({error:`HTTP ${r.status}`}));
      throw new Error(d.error||'Research request failed.');
    }
    const reader=r.body.getReader(), decoder=new TextDecoder();
    let buffer='', complete=null;
    while(true){
      const {done,value}=await reader.read(); if(done)break;
      buffer+=decoder.decode(value,{stream:true});
      let split;
      while((split=buffer.indexOf('\n\n'))>=0){
        const block=buffer.slice(0,split); buffer=buffer.slice(split+2);
        const line=block.split('\n').find(x=>x.startsWith('data: ')); if(!line)continue;
        let event; try{event=JSON.parse(line.slice(6))}catch{continue}
        if(event.event==='error') throw new Error(event.error||'Research request failed.');
        if(event.event==='complete') complete=event;
        onEvent?.(event);
      }
    }
    if(!complete) throw new Error('Research stream ended without a final response.');
    return complete;
  }

  class ResearchWindow{
    constructor(opts={}){
      const n=document.querySelector('#research-template').content.firstElementChild.cloneNode(true);
      const input=n.querySelector('.research-query'), count=n.querySelector('.research-count'), go=n.querySelector('.research-go');
      const status=n.querySelector('.research-status'), answer=n.querySelector('.research-answer'), sources=n.querySelector('.research-sources');
      let running=false, buffer='';
      const run=async()=>{
        if(running||!input.value.trim())return;
        running=true; buffer=''; answer.textContent=''; sources.innerHTML=''; go.disabled=true; status.textContent='Searching…';
        try{
          await streamResearch(input.value,(e)=>{
            if(e.event==='research_search_start') status.textContent=`Searching for ${e.requested_sources||count.value} sources…`;
            else if(e.event==='research_sources'){
              status.textContent=`${e.sources_selected} sources · ~${e.estimated_evidence_tokens} evidence tokens`;
              sources.innerHTML=(e.sources||[]).map(s=>`<a class="research-source" href="${esc(s.url)}" target="_blank" rel="noopener"><b>[${s.index}] ${esc(s.title)}</b><small>${esc(s.domain||s.url)}</small></a>`).join('');
            }else if(e.event==='model_loading') status.textContent=`Loading ${e.name||'model'}…`;
            else if(e.event==='inference_start') status.textContent=`Answering · ~${Number(e.estimated_context_tokens||0).toLocaleString()} context tokens`;
            else if(e.event==='token'){buffer+=String(e.text||'');answer.textContent=buffer;answer.scrollTop=answer.scrollHeight;}
            else if(e.event==='complete') status.textContent=`Done · ${e.sources?.length||0} sources`;
          },Number(count.value));
        }catch(err){status.textContent='Error';answer.textContent=err.message||String(err)}
        finally{running=false;go.disabled=false}
      };
      go.onclick=run; input.onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();run()}};
      this.window=new ApplicationWindow({title:'Research',label:`research-${Date.now()}`,x:opts.x,y:opts.y,width:opts.width||'760',height:opts.height||'620',launcher:{name:'ResearchWindow',opts:{...opts}},mount:n,onclose:()=>n.remove()});
      setTimeout(()=>input.focus(),50);
    }
  }
  window.BrowserOSResearch={stream:streamResearch};
  window.ResearchWindow=ResearchWindow;
})();
