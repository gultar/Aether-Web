(function(){
  const escapeHtml=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

  function successfulTrace(traces){
    if(!Array.isArray(traces) || !traces.length)return false;
    return traces.every(trace=>{
      const result=String(trace?.result||'').trim().toLowerCase();
      return !result.startsWith('tool error:') && !result.startsWith('tool is disabled') && !result.startsWith('failed:');
    });
  }

  async function post(url,body){
    const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    const data=await response.json().catch(()=>({error:`HTTP ${response.status}`}));
    if(!response.ok)throw new Error(data.error||`HTTP ${response.status}`);
    return data;
  }

  function modalShell(){
    let overlay=document.querySelector('.skill-draft-overlay');
    if(overlay)overlay.remove();
    overlay=document.createElement('div');
    overlay.className='skill-draft-overlay';
    overlay.innerHTML=`
      <section class="skill-draft-modal" role="dialog" aria-modal="true" aria-label="Skill draft">
        <header><div><strong>Teach Agent a Skill</strong><small>Review before saving. Existing skills are never overwritten.</small></div><button type="button" class="skill-draft-close" aria-label="Close">×</button></header>
        <div class="skill-draft-status muted"></div>
        <textarea class="skill-draft-text" spellcheck="false"></textarea>
        <footer><button type="button" class="skill-draft-discard">Discard</button><button type="button" class="skill-draft-save">Save Skill</button></footer>
      </section>`;
    document.body.appendChild(overlay);
    const close=()=>overlay.remove();
    overlay.querySelector('.skill-draft-close').onclick=close;
    overlay.querySelector('.skill-draft-discard').onclick=close;
    overlay.addEventListener('mousedown',event=>{if(event.target===overlay)close()});
    return {overlay,close,status:overlay.querySelector('.skill-draft-status'),text:overlay.querySelector('.skill-draft-text'),save:overlay.querySelector('.skill-draft-save')};
  }

  async function teach(payload){
    if(!successfulTrace(payload?.tool_traces))throw new Error('Only a completed run with successful tool calls can be taught as a skill.');
    const ui=modalShell();
    ui.status.textContent='Ministral is checking existing skills and distilling the successful tool trace…';
    ui.text.readOnly=true; ui.text.placeholder='Ministral is distilling the successful tool trace…'; ui.save.disabled=true;
    try{
      let data=await post('/api/os/skills/teach',{...payload,force_new:false});
      if(data.status==='covered'){
        const skill=data.covered_by||{};
        const createAnyway=window.confirm(`This task appears to be covered by the existing skill “${skill.name||'unknown'}”.\n\n${skill.description||''}\n\nCreate a separate draft anyway?`);
        if(!createAnyway){ui.close();return {status:'covered',skill};}
        ui.status.textContent='Creating a separate skill draft by your choice…';
        data=await post('/api/os/skills/teach',{...payload,force_new:true});
      }
      if(data.status!=='draft' || !data.draft)throw new Error('The agent did not return a valid skill draft.');
      if(!String(data.draft).trimStart().startsWith('---'))throw new Error('BrowserOS returned an invalid skill draft.');
      ui.text.value=data.draft;
      ui.text.placeholder=''; ui.text.readOnly=false; ui.save.disabled=false;
      const repairNotes=Array.isArray(data.normalization?.notes)?data.normalization.notes:[];
      ui.status.textContent=repairNotes.length
        ? `Draft: ${data.skill?.name||'new skill'} — BrowserOS repaired: ${repairNotes.join('; ')}. Review before saving.`
        : `Draft: ${data.skill?.name||'new skill'} — edit anything you want before saving.`;
      ui.save.onclick=async()=>{
        ui.save.disabled=true; ui.text.readOnly=true; ui.status.textContent='Validating and saving skill…';
        try{
          const saved=await post('/api/os/skills/save',{draft:ui.text.value});
          ui.status.innerHTML=`Saved <strong>${escapeHtml(saved.skill?.name||'skill')}</strong>. It is available to the selector on the next request.`;
          ui.save.textContent='Saved';
          setTimeout(()=>ui.close(),900);
        }catch(error){
          ui.status.textContent=error.message||String(error); ui.save.disabled=false; ui.text.readOnly=false;
        }
      };
      ui.text.focus();
      return data;
    }catch(error){
      // A failed teach request should never strand BrowserOS behind an empty modal.
      ui.close();
      throw error;
    }
  }

  function makeTeachButton(payload,label='Teach Agent a Skill'){
    const button=document.createElement('button');
    button.type='button'; button.className='teach-skill-button'; button.textContent=label;
    button.disabled=!successfulTrace(payload?.tool_traces);
    button.onclick=async()=>{
      button.disabled=true;
      const old=button.textContent; button.textContent='Drafting skill…';
      try{await teach(payload)}catch(error){console.error('Skill teaching failed',error);window.alert(error.message||error)}
      finally{button.textContent=old;button.disabled=!successfulTrace(payload?.tool_traces)}
    };
    return button;
  }

  async function list(){
    const response=await fetch('/api/os/skills',{cache:'no-store'});
    const data=await response.json().catch(()=>({error:`HTTP ${response.status}`}));
    if(!response.ok)throw new Error(data.error||`HTTP ${response.status}`);
    return Array.isArray(data.skills)?data.skills:[];
  }

  window.BrowserOSSkills={teach,makeTeachButton,canTeach:successfulTrace,list};
})();
