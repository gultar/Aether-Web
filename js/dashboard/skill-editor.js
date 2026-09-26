(function(){
  const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const API='/api/os/skills';
  const CATEGORY_API='/api/os/categories';

  async function request(url,options={}){
    const response=await fetch(url,{cache:'no-store',...options});
    const data=await response.json().catch(()=>({error:`HTTP ${response.status}`}));
    if(!response.ok)throw new Error(data.error||`HTTP ${response.status}`);
    return data;
  }

  function draftName(text){
    const match=String(text||'').match(/^name\s*:\s*["']?([^\r\n"']+)/mi);
    return match?match[1].trim().toLowerCase():'';
  }

  function newTemplate(name='new-skill',category='General'){
    return `---\nname: ${name}\ndescription: Describe when this skill should be selected.\ncategory: ${category}\ntools: []\n---\n\n# Procedure\n\n1. Describe the smallest reliable sequence of steps.\n2. Keep instructions reusable rather than tied to one conversation.\n\n# Success\n\nDescribe how the agent knows the task is complete.\n`;
  }

  function replaceDraftCategory(text,category){
    if(/^category\s*:/mi.test(text))return text.replace(/^category\s*:\s*.*$/mi,`category: ${category}`);
    const lines=String(text||'').split(/\r?\n/);
    const end=lines.findIndex((line,index)=>index>0&&line.trim()==='---');
    if(end>0){lines.splice(end,0,`category: ${category}`);return lines.join('\n');}
    return text;
  }

  function nextCopyName(base,names){
    const stem=String(base||'skill').replace(/-copy(?:-\d+)?$/,'');
    let candidate=`${stem}-copy`,i=2;
    while(names.has(candidate)){candidate=`${stem}-copy-${i++}`;}
    return candidate.slice(0,64);
  }

  function replaceDraftName(text,name){
    if(/^name\s*:/mi.test(text))return text.replace(/^name\s*:\s*.*$/mi,`name: ${name}`);
    return text;
  }

  class SkillEditorWindow{
    constructor(opts={}){
      this.skills=[];this.categories=[];this.selected=null;this.initialText='';this.dirty=false;
      const host=document.createElement('section');
      host.className='skill-editor-app';
      host.innerHTML=`
        <header class="skill-editor-toolbar">
          <div class="skill-editor-heading"><strong>Skills Editor</strong><small>Procedural knowledge loaded on demand by Ministral</small></div>
          <div class="skill-editor-toolbar-actions">
            <button type="button" data-action="new">+ New</button>
            <button type="button" data-action="duplicate" disabled>Duplicate</button>
            <button type="button" data-action="move-category" disabled>Move Category</button>
            <button type="button" data-action="refresh">Refresh</button>
          </div>
        </header>
        <div class="skill-editor-layout">
          <aside class="skill-editor-sidebar">
            <div class="skill-editor-category-manager">
              <select class="skill-editor-category" aria-label="Filter by category"><option value="">All categories</option></select>
              <div class="skill-editor-category-actions">
                <button type="button" data-action="category-new" title="Create category">+ Category</button>
                <button type="button" data-action="category-edit" title="Rename or edit category" disabled>Edit</button>
                <button type="button" data-action="category-delete" class="danger" title="Delete category" disabled>Delete</button>
              </div>
              <small class="skill-editor-category-description">All skill categories.</small>
              <div class="skill-editor-category-form" hidden>
                <label><span>Name</span><input type="text" class="skill-editor-category-name" maxlength="48"></label>
                <label><span>Routing description</span><textarea class="skill-editor-category-routing" rows="3" maxlength="320"></textarea></label>
                <div class="skill-editor-category-form-actions">
                  <button type="button" data-action="category-cancel">Cancel</button>
                  <button type="button" data-action="category-save" class="primary">Save Category</button>
                </div>
              </div>
            </div>
            <input type="search" class="skill-editor-search" placeholder="Filter skills…" autocomplete="off" spellcheck="false">
            <div class="skill-editor-list" role="listbox" aria-label="Installed skills"></div>
          </aside>
          <main class="skill-editor-main">
            <div class="skill-editor-current">
              <div><strong class="skill-editor-name">No skill selected</strong><small class="skill-editor-description">Choose a skill or create a new one.</small></div>
              <div class="skill-editor-badges"></div>
            </div>
            <textarea class="skill-editor-text" spellcheck="false" aria-label="SKILL.md editor"></textarea>
            <div class="skill-editor-footer">
              <div class="skill-editor-status muted">Loading skills…</div>
              <div class="skill-editor-actions">
                <button type="button" data-action="validate">Validate</button>
                <button type="button" data-action="delete" class="danger" disabled>Delete</button>
                <button type="button" data-action="save-new">Save as New</button>
                <button type="button" data-action="save" class="primary" disabled>Save</button>
              </div>
            </div>
          </main>
        </div>`;
      document.querySelector('#window-mounts').appendChild(host);
      this.host=host;
      const width=opts.width||Math.min(1120,Math.max(820,window.innerWidth-150));
      const height=opts.height||Math.min(760,Math.max(580,window.innerHeight-120));
      this.window=new ApplicationWindow({
        title:'Skills Editor',label:`skills-editor-${Date.now()}`,x:opts.x,y:opts.y,width:String(width),height:String(height),
        launcher:{name:'SkillEditorWindow',opts:{...opts}},mount:host,onclose:()=>host.remove()
      });
      this.listEl=host.querySelector('.skill-editor-list');
      this.categoryEl=host.querySelector('.skill-editor-category');
      this.searchEl=host.querySelector('.skill-editor-search');
      this.textEl=host.querySelector('.skill-editor-text');
      this.nameEl=host.querySelector('.skill-editor-name');
      this.descEl=host.querySelector('.skill-editor-description');
      this.badgesEl=host.querySelector('.skill-editor-badges');
      this.statusEl=host.querySelector('.skill-editor-status');
      this.saveBtn=host.querySelector('[data-action="save"]');
      this.saveNewBtn=host.querySelector('[data-action="save-new"]');
      this.deleteBtn=host.querySelector('[data-action="delete"]');
      this.duplicateBtn=host.querySelector('[data-action="duplicate"]');
      this.moveCategoryBtn=host.querySelector('[data-action="move-category"]');
      this.categoryEditBtn=host.querySelector('[data-action="category-edit"]');
      this.categoryDeleteBtn=host.querySelector('[data-action="category-delete"]');
      this.categoryDescEl=host.querySelector('.skill-editor-category-description');
      this.categoryForm=host.querySelector('.skill-editor-category-form');
      this.categoryNameInput=host.querySelector('.skill-editor-category-name');
      this.categoryRoutingInput=host.querySelector('.skill-editor-category-routing');
      this.categoryFormMode=null;
      this.categoryEditingOriginal=null;
      this.bind();
      this.refresh();
    }

    bind(){
      this.categoryEl.addEventListener('change',()=>{this.renderCategoryState();this.renderList()});
      this.host.querySelector('[data-action="category-new"]').onclick=()=>this.createCategory();
      this.categoryEditBtn.onclick=()=>this.editCategory();
      this.categoryDeleteBtn.onclick=()=>this.deleteCategory();
      this.host.querySelector('[data-action="category-cancel"]').onclick=()=>this.closeCategoryForm();
      this.host.querySelector('[data-action="category-save"]').onclick=()=>this.saveCategoryForm();
      this.moveCategoryBtn.onclick=()=>this.moveSelectedCategory();
      this.searchEl.addEventListener('input',()=>this.renderList());
      this.textEl.addEventListener('input',()=>{this.dirty=this.textEl.value!==this.initialText;this.updateTitle();this.setStatus(this.dirty?'Unsaved changes.':'Ready.','muted')});
      this.host.querySelector('[data-action="new"]').onclick=()=>this.newSkill();
      this.host.querySelector('[data-action="duplicate"]').onclick=()=>this.duplicate();
      this.host.querySelector('[data-action="refresh"]').onclick=()=>this.refresh(true);
      this.host.querySelector('[data-action="validate"]').onclick=()=>this.validate();
      this.saveBtn.onclick=()=>this.saveExisting();
      this.saveNewBtn.onclick=()=>this.saveAsNew();
      this.deleteBtn.onclick=()=>this.removeSelected();
      this.host.addEventListener('keydown',event=>{
        if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='s'){
          event.preventDefault();
          if(event.shiftKey)this.saveAsNew();else if(this.selected)this.saveExisting();else this.saveAsNew();
        }
      });
    }

    setStatus(text,kind='muted'){
      this.statusEl.className=`skill-editor-status ${kind}`;
      this.statusEl.textContent=text;
    }

    updateTitle(){
      const label=this.selected?.name||draftName(this.textEl.value)||'New skill';
      this.nameEl.textContent=label+(this.dirty?' *':'');
    }

    async guardDirty(){
      return !this.dirty || window.confirm('Discard the unsaved changes in the current skill?');
    }

    async refresh(guard=false){
      if(guard && !(await this.guardDirty()))return;
      this.setStatus('Loading skills…');
      try{
        const data=await request(API);
        this.skills=Array.isArray(data.skills)?data.skills:[];
        this.categories=Array.isArray(data.categories)?data.categories:[];
        this.renderCategories();
        this.renderList();
        if(this.selected){
          const found=this.skills.find(s=>s.name===this.selected.name);
          if(found)await this.loadSkill(found.name,false);else this.newSkill(false);
        }else if(!this.textEl.value && this.skills.length){
          const preferred=this.skills.find(s=>s.name==='general')||this.skills[0];
          await this.loadSkill(preferred.name,false);
        }
        this.setStatus(`${this.skills.length} skill${this.skills.length===1?'':'s'} installed.`,'ok');
      }catch(error){this.setStatus(error.message||String(error),'error')}
    }

    renderCategories(){
      const selected=this.categoryEl.value;
      const records=this.categories.length?this.categories:[...new Set(this.skills.map(skill=>skill.category||'General'))].map(name=>({name,description:'',count:this.skills.filter(s=>(s.category||'General')===name).length,protected:name==='General'}));
      this.categoryEl.innerHTML='<option value="">All categories</option>';
      for(const category of records){
        const option=document.createElement('option');option.value=category.name;option.textContent=`${category.name} (${category.count||0})`;this.categoryEl.appendChild(option);
      }
      this.categoryEl.value=records.some(c=>c.name===selected)?selected:'';
      this.renderCategoryState();
    }

    renderCategoryState(){
      const name=this.categoryEl.value;
      const record=this.categories.find(c=>c.name===name);
      this.categoryEditBtn.disabled=!name;
      this.categoryDeleteBtn.disabled=!name||name==='General'||Boolean(record?.protected);
      this.categoryDescEl.textContent=!name?'All skill categories.':(record?.description||`${record?.count||0} skill${record?.count===1?'':'s'} in ${name}.`);
    }

    openCategoryForm(mode,record={}){
      this.categoryFormMode=mode;
      this.categoryEditingOriginal=mode==='edit'?(record.name||this.categoryEl.value):null;
      this.categoryNameInput.value=mode==='edit'?(record.name||''):'';
      this.categoryRoutingInput.value=mode==='edit'?(record.description||''):'';
      this.categoryNameInput.disabled=mode==='edit' && (record.name==='General'||record.protected);
      this.categoryForm.hidden=false;
      this.categoryNameInput.focus();
    }

    closeCategoryForm(){
      this.categoryForm.hidden=true;
      this.categoryFormMode=null;
      this.categoryEditingOriginal=null;
      this.categoryNameInput.disabled=false;
    }

    async createCategory(){
      this.openCategoryForm('create',{name:'',description:''});
    }

    async editCategory(){
      const current=this.categoryEl.value;if(!current)return;
      const record=this.categories.find(c=>c.name===current)||{name:current,description:''};
      this.openCategoryForm('edit',record);
    }

    async saveCategoryForm(){
      const mode=this.categoryFormMode;if(!mode)return;
      const name=this.categoryNameInput.value.trim();
      const description=this.categoryRoutingInput.value.trim();
      if(!name){this.setStatus('Category name is required.','error');this.categoryNameInput.focus();return;}
      const saveBtn=this.host.querySelector('[data-action="category-save"]');
      saveBtn.disabled=true;
      try{
        let data;
        if(mode==='create'){
          this.setStatus(`Creating category ${name}…`);
          data=await request(CATEGORY_API,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,description})});
        }else{
          const current=this.categoryEditingOriginal;if(!current)return;
          this.setStatus(`Updating category ${current}…`);
          data=await request(`${CATEGORY_API}/${encodeURIComponent(current)}`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,description})});
        }
        await this.reloadListOnly();
        const savedName=data.category?.name||name;
        this.categoryEl.value=savedName;
        this.renderCategoryState();this.renderList();this.notifySkillsChanged();
        if(this.selected){
          const found=this.skills.find(s=>s.name===this.selected.name);
          if(found){this.selected=found;await this.loadSkill(found.name,false);}
        }
        this.closeCategoryForm();
        this.setStatus(`${mode==='create'?'Created':'Updated'} category ${savedName}.`,'ok');
      }catch(error){
        this.setStatus(error.message||String(error),'error');
      }finally{
        saveBtn.disabled=false;
      }
    }

    async deleteCategory(){
      const current=this.categoryEl.value;if(!current||current==='General')return;
      const record=this.categories.find(c=>c.name===current)||{};
      const alternatives=this.categories.filter(c=>c.name!==current).map(c=>c.name);
      const target=window.prompt(`Delete category “${current}”?

${record.count||0} skill(s) will be reassigned. Enter destination category:
${alternatives.join(', ')}`,'General');
      if(target===null||!target.trim())return;
      if(!window.confirm(`Delete “${current}” and move its skills to “${target.trim()}”?`))return;
      this.setStatus(`Deleting category ${current}…`);
      try{
        const data=await request(`${CATEGORY_API}/${encodeURIComponent(current)}`,{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({reassign_to:target.trim()})});
        await this.reloadListOnly();this.categoryEl.value=data.reassigned_to||'General';this.renderCategoryState();this.renderList();this.notifySkillsChanged();
        if(this.selected){const found=this.skills.find(s=>s.name===this.selected.name);if(found){this.selected=found;await this.loadSkill(found.name,false);}}
        this.setStatus(`Deleted ${current}; reassigned ${data.updated_skills?.length||0} skill(s) to ${data.reassigned_to}.`,'ok');
      }catch(error){this.setStatus(error.message||String(error),'error')}
    }

    async moveSelectedCategory(){
      if(!this.selected)return;
      const names=this.categories.map(c=>c.name);
      const current=this.selected.category||'General';
      const target=window.prompt(`Move ${this.selected.name} to which category?

${names.join(', ')}`,current);
      if(target===null||!target.trim()||target.trim()===current)return;
      const match=names.find(name=>name.toLowerCase()===target.trim().toLowerCase());
      if(!match){this.setStatus(`Unknown category: ${target.trim()}`,'error');return;}
      this.textEl.value=replaceDraftCategory(this.textEl.value,match);this.dirty=this.textEl.value!==this.initialText;this.updateTitle();
      this.setStatus(`Draft moved to ${match}. Click Save to apply.`,'muted');
    }

    renderList(){
      const q=this.searchEl.value.trim().toLowerCase();
      const categoryFilter=this.categoryEl.value;
      const visible=this.skills.filter(skill=>{
        const category=skill.category||'General';
        return (!categoryFilter||category===categoryFilter) && (!q||skill.name.includes(q)||String(skill.description||'').toLowerCase().includes(q)||category.toLowerCase().includes(q));
      });
      this.listEl.innerHTML='';
      const grouped=new Map();
      for(const skill of visible){
        const category=skill.category||'General';
        if(!grouped.has(category))grouped.set(category,[]);
        grouped.get(category).push(skill);
      }
      for(const category of [...grouped.keys()].sort((a,b)=>a.localeCompare(b))){
        const heading=document.createElement('div');heading.className='skill-editor-category-heading';heading.textContent=category;this.listEl.appendChild(heading);
        for(const skill of grouped.get(category).sort((a,b)=>a.name.localeCompare(b.name))){
          const row=document.createElement('button');row.type='button';row.className='skill-editor-list-item'+(this.selected?.name===skill.name?' active':'');
          row.setAttribute('role','option');row.setAttribute('aria-selected',String(this.selected?.name===skill.name));
          row.innerHTML=`<span class="skill-editor-list-name">${esc(skill.name)}</span><span class="skill-editor-list-desc">${esc(skill.description||'')}</span><span class="skill-editor-list-meta">${esc(category)} · ${skill.starter?'starter':'custom'} · ${(skill.tools||[]).length} tool${(skill.tools||[]).length===1?'':'s'}</span>`;
          row.onclick=()=>this.loadSkill(skill.name,true);
          this.listEl.appendChild(row);
        }
      }
      if(!visible.length)this.listEl.innerHTML='<div class="skill-editor-empty">No matching skills.</div>';
    }

    async loadSkill(name,guard=true){
      if(guard && !(await this.guardDirty()))return;
      this.setStatus(`Loading ${name}…`);
      try{
        const data=await request(`${API}/${encodeURIComponent(name)}`);
        this.selected=data.skill;this.initialText=data.text||'';this.textEl.value=this.initialText;this.dirty=false;
        this.renderSelection();this.renderList();this.setStatus('Ready.','ok');
      }catch(error){this.setStatus(error.message||String(error),'error')}
    }

    renderSelection(){
      const skill=this.selected;
      if(!skill){
        this.nameEl.textContent=draftName(this.textEl.value)||'New skill';
        this.descEl.textContent='Not saved yet. Validate, then Save as New.';
        this.badgesEl.innerHTML='<span>draft</span>';
        this.saveBtn.disabled=true;this.deleteBtn.disabled=true;this.duplicateBtn.disabled=true;this.moveCategoryBtn.disabled=true;return;
      }
      this.nameEl.textContent=skill.name+(this.dirty?' *':'');
      this.descEl.textContent=skill.description||'';
      this.badgesEl.innerHTML=`<span class="category">${esc(skill.category||'General')}</span><span>${skill.starter?'starter':'custom'}</span><span>${(skill.tools||[]).length} tools</span><span>${esc(skill.filename||`${skill.name}.md`)}</span>`;
      this.saveBtn.disabled=false;this.deleteBtn.disabled=!skill.deletable;this.duplicateBtn.disabled=false;this.moveCategoryBtn.disabled=false;
    }

    async newSkill(guard=true){
      if(guard && !(await this.guardDirty()))return;
      this.selected=null;this.initialText='';this.textEl.value=newTemplate('new-skill',this.categoryEl.value||'General');this.dirty=true;this.renderSelection();this.renderList();
      this.setStatus('New draft. Choose a unique name and describe when it should be selected.','muted');this.textEl.focus();
    }

    async duplicate(){
      if(!this.selected)return;
      const names=new Set(this.skills.map(s=>s.name));
      const name=nextCopyName(this.selected.name,names);
      this.selected=null;this.textEl.value=replaceDraftName(this.textEl.value,name);this.initialText='';this.dirty=true;this.renderSelection();this.renderList();
      this.setStatus(`Duplicated as draft “${name}”. Save as New when ready.`,'muted');
    }

    async validate(){
      this.setStatus('Validating YAML, instructions and tools…');
      try{
        const data=await request(`${API}/validate`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:this.textEl.value})});
        const skill=data.skill||{};
        this.setStatus(`Valid: ${skill.name} · ${(skill.tools||[]).length} tools${data.exists?' · name already exists':''}.`,'ok');
        return data;
      }catch(error){this.setStatus(error.message||String(error),'error');throw error}
    }

    async saveExisting(){
      if(!this.selected)return this.saveAsNew();
      this.setStatus(`Saving ${this.selected.name}…`);
      this.saveBtn.disabled=true;
      try{
        const data=await request(`${API}/${encodeURIComponent(this.selected.name)}`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:this.textEl.value})});
        this.selected=data.skill;this.initialText=this.textEl.value.trim()+'\n';this.textEl.value=this.initialText;this.dirty=false;
        await this.reloadListOnly();this.renderSelection();this.notifySkillsChanged();this.setStatus(`Saved ${this.selected.name}.`,'ok');
      }catch(error){this.setStatus(error.message||String(error),'error')}
      finally{this.saveBtn.disabled=!this.selected}
    }

    async saveAsNew(){
      this.setStatus('Validating and saving new skill…');this.saveNewBtn.disabled=true;
      try{
        const data=await request(`${API}/save`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({draft:this.textEl.value})});
        await this.reloadListOnly();await this.loadSkill(data.skill.name,false);this.notifySkillsChanged();this.setStatus(`Created ${data.skill.name}.`,'ok');
      }catch(error){this.setStatus(error.message||String(error),'error')}
      finally{this.saveNewBtn.disabled=false}
    }

    async removeSelected(){
      if(!this.selected)return;
      const kind=this.selected.starter?'built-in':'custom';
      if(!window.confirm(`Delete ${kind} skill “${this.selected.name}”?\n\nThe skill will be removed from BrowserOS. Built-in deletions are remembered so they do not reappear on restart. This does not delete chats, tasks, tools, project data, or Riftbreakers.`))return;
      const name=this.selected.name;this.setStatus(`Deleting ${name}…`);this.deleteBtn.disabled=true;
      try{
        await request(`${API}/${encodeURIComponent(name)}`,{method:'DELETE'});
        this.selected=null;this.initialText='';this.textEl.value='';this.dirty=false;
        await this.reloadListOnly();this.notifySkillsChanged();
        if(this.skills.length)await this.loadSkill((this.skills.find(s=>s.name==='general')||this.skills[0]).name,false);else await this.newSkill(false);
        this.setStatus(`Deleted ${name}.`,'ok');
      }catch(error){this.setStatus(error.message||String(error),'error');this.deleteBtn.disabled=!this.selected?.deletable}
    }

    async reloadListOnly(){
      const data=await request(API);this.skills=Array.isArray(data.skills)?data.skills:[];this.categories=Array.isArray(data.categories)?data.categories:[];this.renderCategories();this.renderList();
    }

    notifySkillsChanged(){
      document.querySelectorAll('iframe.tiny-agent-frame').forEach(frame=>{
        try{frame.contentWindow?.postMessage({type:'browseros-skills-changed'},'*')}catch(_){ }
      });
      window.dispatchEvent(new CustomEvent('browseros-skills-changed'));
    }
  }

  let lastOpen=0;
  function openEditor(opts={}){
    // Avoid double opening when a click bubbles through more than one launcher surface.
    if(Date.now()-lastOpen<250)return;lastOpen=Date.now();
    return new SkillEditorWindow(opts);
  }

  window.addEventListener('message',event=>{
    if(event?.data?.type==='browseros-open-skill-editor')openEditor();
  });
  window.SkillEditorWindow=SkillEditorWindow;
  window.openSkillEditor=openEditor;
})();
