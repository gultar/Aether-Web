class OSAgentWindow {
  constructor(opts={}) {
    const host=document.createElement('section');
    host.className='tool os-agent-window';
    host.innerHTML=`
      <header class="tool-head"><span>OS Agent</span><small>Focused Browser-OS context</small></header>
      <div class="os-agent-body">
        <div class="os-agent-skill-row"><label>Skill <select class="os-agent-skill"><option value="">Auto — Ministral chooses</option></select></label><span class="muted os-agent-skill-help">Only the selected skill's tools are exposed.</span></div>
        <div class="os-agent-log"><p class="muted">BrowserOS agent · Auto skill routing · general baseline: DuckDuckGo + CBC news.</p></div>
        <div class="os-agent-input-row">
          <input class="os-agent-input" placeholder="Ask BrowserOS…" autocomplete="off">
          <button class="os-agent-send">Run</button>
        </div>
      </div>`;
    const log=host.querySelector('.os-agent-log');
    const input=host.querySelector('.os-agent-input');
    const send=host.querySelector('.os-agent-send');
    const skillSelect=host.querySelector('.os-agent-skill');
    const loadSkills=async()=>{
      try{
        const skills=await BrowserOSSkills.list();
        for(const skill of skills){
          const option=document.createElement('option');
          option.value=skill.name; option.textContent=`${skill.name} — ${skill.description}`;
          skillSelect.appendChild(option);
        }
      }catch(error){
        const option=document.createElement('option'); option.disabled=true; option.textContent='Unable to load skills'; skillSelect.appendChild(option);
        console.error('Skill list failed',error);
      }
    };
    loadSkills();
    const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const run=async()=>{
      const q=input.value.trim(); if(!q)return;
      log.insertAdjacentHTML('beforeend',`<p><b>You:</b> ${esc(q)}</p>`);
      input.value=''; input.disabled=true; send.disabled=true;
      try {
        const toolNames={duckduckgo_search:'DuckDuckGo search',cbc_top_stories:'News',browser_window:'Window control',browser_system_info:'System information',browser_note:'Notes',browser_todo:'Todo',browser_timer:'Timer',browser_launch_app:'App launcher',browser_research:'Web research',browser_read_url:'Read URL',browser_project_list:'Project files',browser_project_read:'Read project file',browser_project_find:'Search project source',browser_project_replace:'Edit project file',browser_project_write:'Write project file',browser_project_check:'Check project file',browser_project_run:'Run project code/tests',browser_project_npm:'npm package'};
        let streamRow=null, streamText=null, streamBuffer='';
        const finishStream=()=>{if(streamRow){streamRow.querySelector('.os-stream-cursor')?.remove();streamRow=null;streamText=null;streamBuffer=''}};
        const d=await BrowserOSAgent.queryStream(q,event=>{
          if(event.event==='token'){
            if(!streamRow){streamRow=document.createElement('p');streamRow.className='os-stream-response';streamRow.innerHTML='<b>OS:</b> <span class="os-stream-text"></span><span class="os-stream-cursor">▌</span>';log.appendChild(streamRow);streamText=streamRow.querySelector('.os-stream-text')}
            streamBuffer+=String(event.text||'');streamText.textContent=streamBuffer;
          }
          if(event.event==='skill_selection_start'){
            const mode=event.mode==='manual'?'Manual selection':event.mode==='devmode'?'Dev mode':'Ministral selecting procedure';
            log.insertAdjacentHTML('beforeend',`<p class="muted">[skill] ${esc(mode)}…</p>`);
          }
          if(event.event==='skill_selected') log.insertAdjacentHTML('beforeend',`<p class="muted">[skill] ${esc(event.skill||'general')} — ${esc(event.description||'')} (${esc(event.selection_mode||'auto')})</p>`);
          if(event.event==='model_loading') log.insertAdjacentHTML('beforeend',`<p class="muted">[model] Loading ${esc(event.name||'model')}…</p>`);
          if(event.event==='inference_start') log.insertAdjacentHTML('beforeend',`<p class="muted">[thinking] ${event.estimated_context_tokens!=null?'~'+Number(event.estimated_context_tokens).toLocaleString()+' context tokens · ':''}${event.tools??0} tools available</p>`);
          if(event.event==='tool_start'){
            finishStream();
            const args=Object.entries(event.arguments||{}).map(([k,v])=>`${esc(k)}=${esc(typeof v==='string'?v:JSON.stringify(v))}`).join(' · ');
            log.insertAdjacentHTML('beforeend',`<p><b>[tool ${event.sequence||'?'}] ${esc(toolNames[event.name]||event.name)}</b><br><span class="muted">${args||'no arguments'}</span></p>`);
          }
          if(event.event==='tool_end'){
            let result=String(event.result||'Completed.'); if(result.length>500)result=result.slice(0,500)+'…';
            log.insertAdjacentHTML('beforeend',`<p class="muted">[tool ${event.sequence||'?'} result${event.duration_seconds!=null?' · '+Number(event.duration_seconds).toFixed(3)+'s':''}] ${esc(result)}</p>`);
          }
          log.scrollTop=log.scrollHeight;
        },{skill:skillSelect.value||null});
        const hadStream=!!streamRow;
        finishStream();
        if(!hadStream) log.insertAdjacentHTML('beforeend',`<p><b>OS:</b> ${esc(d.response||'Done.')}</p>`);
        if(window.BrowserOSSkills?.canTeach(d.tool_traces)){
          const row=document.createElement('p');
          row.className='skill-teach-offer';
          row.appendChild(BrowserOSSkills.makeTeachButton({task:q,response:d.response||'',tool_traces:d.tool_traces||[],selected_skill:d.skill||null}));
          log.appendChild(row);
        }
      } catch(e) {
        log.insertAdjacentHTML('beforeend',`<p><b>Error:</b> ${esc(e.message||e)}</p>`);
      } finally { input.disabled=false; send.disabled=false; input.focus(); log.scrollTop=log.scrollHeight; }
    };
    send.onclick=run;
    input.addEventListener('keydown',e=>{if(e.key==='Enter')run()});
    this.window=new ApplicationWindow({title:'OS Agent',label:`os-agent-${Date.now()}`,x:opts.x,y:opts.y,width:opts.width||'620',height:opts.height||'430',launcher:{name:'OSAgentWindow',opts:{...opts}},mount:host,onclose:()=>host.remove()});
    setTimeout(()=>input.focus(),50);
  }
}
window.OSAgentWindow=OSAgentWindow;
