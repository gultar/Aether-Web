(function(){
  const API='/api/os/tool-editor';
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  async function request(url,options={}){
    const r=await fetch(url,{cache:'no-store',...options});
    const d=await r.json().catch(()=>({error:`HTTP ${r.status}`}));
    if(!r.ok)throw new Error(d.error||`HTTP ${r.status}`);return d;
  }
  const ident=v=>String(v||'').trim().replace(/[^A-Za-z0-9_]/g,'_').replace(/^([^A-Za-z_])/,'_$1');
  const q=v=>JSON.stringify(String(v??''));
  function defaultCode(name='my_tool'){
    name=ident(name)||'my_tool';
    return `def ${name}(argument: str) -> str:\n    \"\"\"Implement the tool here. Return text or JSON-serializable data.\"\"\"\n    return f\"Received: {argument}\"\n`;
  }
  function defaultDraft(){return {name:'my_tool',label:'My Tool',description:'Describe clearly when the model should use this tool.',function:'my_tool',timeout_seconds:30,enabled_by_default:false,parameters:[{name:'argument',type:'string',description:'Describe this argument.',required:true}]};}
  function yamlFromDraft(d){
    const props=(d.parameters||[]).filter(p=>p.name).map(p=>`    ${p.name}:\n      type: ${p.type||'string'}\n      description: ${q(p.description||'')}`).join('\n');
    const req=(d.parameters||[]).filter(p=>p.name&&p.required).map(p=>`    - ${p.name}`).join('\n');
    return `name: ${d.name}\nfile: ${d.file||`${d.name}.py`}\nfunction: ${d.function}\nlabel: ${q(d.label)}\ndescription: ${q(d.description)}\nenabled_by_default: ${!!d.enabled_by_default}\ntimeout_seconds: ${Number(d.timeout_seconds)||30}\nparameters:\n  type: object\n  properties:${props?`\n${props}`:' {}'}\n  required:${req?`\n${req}`:' []'}\n`;
  }
  class ToolEditorWindow{
    constructor(opts={}){
      this.tools=[];this.selected=null;this.dirty=false;this.initial='';
      const host=document.createElement('section');host.className='tool-editor-app';
      host.innerHTML=`
        <header class="skill-editor-toolbar">
          <div class="skill-editor-heading"><strong>Tool Editor</strong><small>Create Python tools, generate YAML, validate, then hot-load</small></div>
          <div class="skill-editor-toolbar-actions"><button data-action="new">+ New</button><button data-action="refresh">Refresh</button></div>
        </header>
        <div class="skill-editor-layout tool-editor-layout">
          <aside class="skill-editor-sidebar"><input type="search" class="skill-editor-search" placeholder="Filter tools…"><div class="skill-editor-list"></div></aside>
          <main class="tool-editor-main">
            <div class="skill-editor-current"><div><strong class="tool-editor-title">New tool</strong><small class="tool-editor-subtitle">Structured definition + Python implementation</small></div><div class="skill-editor-badges tool-editor-badges"></div></div>
            <div class="tool-editor-scroll">
              <section class="tool-editor-section"><h3>Definition</h3><div class="tool-editor-grid">
                <label>Name<input class="te-name" spellcheck="false"></label><label>Label<input class="te-label"></label>
                <label class="wide">Description<textarea class="te-description" rows="3"></textarea></label>
                <label>Python file<input class="te-file" spellcheck="false"></label><label>Function<input class="te-function" spellcheck="false"></label><label>Timeout seconds<input class="te-timeout" type="number" min="1" max="3600"></label>
              </div><label class="tool-editor-check"><input class="te-enabled" type="checkbox"> Enabled by default in ordinary Tiny Web Agent chats</label></section>
              <section class="tool-editor-section"><div class="tool-editor-section-head"><h3>Parameters</h3><button data-action="add-param" type="button">+ Parameter</button></div><div class="tool-editor-params"></div><small>These rows become the JSON Schema that Ministral sees. Keep schemas small and explicit.</small></section>
              <section class="tool-editor-section"><h3>Python implementation</h3><textarea class="tool-editor-code" spellcheck="false"></textarea><small>External tools run in a separate Python process. The function must be top-level and accept the schema parameters.</small></section>
              <section class="tool-editor-section"><div class="tool-editor-section-head"><h3>Generated YAML</h3><button data-action="copy-yaml" type="button">Copy</button></div><textarea class="tool-editor-yaml" readonly spellcheck="false"></textarea><small>The backend regenerates and validates this YAML before it is saved. Tool Editor-managed definitions are stored as <code>definitions/&lt;name&gt;.yaml</code>.</small></section>
            </div>
            <div class="skill-editor-footer"><div class="skill-editor-status muted">Loading tools…</div><div class="skill-editor-actions"><button data-action="validate">Validate</button><button data-action="delete" class="danger" disabled>Delete</button><button data-action="save-new">Save as New</button><button data-action="save" class="primary" disabled>Save & Hot-load</button></div></div>
          </main>
        </div>`;
      document.querySelector('#window-mounts').appendChild(host);this.host=host;
      const width=opts.width||Math.min(1180,Math.max(860,window.innerWidth-130)),height=opts.height||Math.min(790,Math.max(610,window.innerHeight-100));
      this.window=new ApplicationWindow({title:'Tool Editor',label:`tool-editor-${Date.now()}`,x:opts.x,y:opts.y,width:String(width),height:String(height),launcher:{name:'ToolEditorWindow',opts:{...opts}},mount:host,onclose:()=>host.remove()});
      this.listEl=host.querySelector('.skill-editor-list');this.searchEl=host.querySelector('.skill-editor-search');this.paramsEl=host.querySelector('.tool-editor-params');this.statusEl=host.querySelector('.skill-editor-status');this.yamlEl=host.querySelector('.tool-editor-yaml');this.codeEl=host.querySelector('.tool-editor-code');
      this.bind();this.newTool(false);this.refresh(false);
    }
    bind(){
      this.searchEl.oninput=()=>this.renderList();
      this.host.querySelector('[data-action="new"]').onclick=()=>this.newTool(true);
      this.host.querySelector('[data-action="refresh"]').onclick=()=>this.refresh(true);
      this.host.querySelector('[data-action="add-param"]').onclick=()=>{this.addParam();this.changed()};
      this.host.querySelector('[data-action="copy-yaml"]').onclick=async()=>{await navigator.clipboard.writeText(this.yamlEl.value);this.setStatus('YAML copied.','ok')};
      this.host.querySelector('[data-action="validate"]').onclick=()=>this.validate();
      this.host.querySelector('[data-action="save-new"]').onclick=()=>this.save(false);
      this.host.querySelector('[data-action="save"]').onclick=()=>this.save(true);
      this.host.querySelector('[data-action="delete"]').onclick=()=>this.remove();
      for(const el of this.host.querySelectorAll('.te-name,.te-label,.te-description,.te-file,.te-function,.te-timeout,.te-enabled,.tool-editor-code'))el.addEventListener('input',()=>this.changed(el));
      this.host.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='s'){e.preventDefault();this.save(!!this.selected)}});
    }
    setStatus(t,k='muted'){this.statusEl.textContent=t;this.statusEl.className=`skill-editor-status ${k}`}
    draft(){return {name:ident(this.host.querySelector('.te-name').value),file:String(this.host.querySelector('.te-file').value||'').trim(),label:this.host.querySelector('.te-label').value.trim(),description:this.host.querySelector('.te-description').value.trim(),function:ident(this.host.querySelector('.te-function').value),timeout_seconds:Number(this.host.querySelector('.te-timeout').value||30),enabled_by_default:this.host.querySelector('.te-enabled').checked,parameters:[...this.paramsEl.querySelectorAll('.tool-editor-param')].map(r=>({name:ident(r.querySelector('.p-name').value),type:r.querySelector('.p-type').value,description:r.querySelector('.p-desc').value.trim(),required:r.querySelector('.p-required').checked})).filter(p=>p.name)};}
    definition(){const d=this.draft();const props={};const required=[];for(const p of d.parameters){props[p.name]={type:p.type,description:p.description};if(p.required)required.push(p.name)}return {name:d.name,file:d.file||`${d.name}.py`,function:d.function,label:d.label,description:d.description,enabled_by_default:d.enabled_by_default,timeout_seconds:d.timeout_seconds,parameters:{type:'object',properties:props,required}}}
    snapshot(){return JSON.stringify({d:this.draft(),code:this.codeEl.value})}
    changed(source){
      if(!this.selected&&source?.classList?.contains('te-name')){
        const n=ident(source.value);const fn=this.host.querySelector('.te-function'),file=this.host.querySelector('.te-file');if(!fn.dataset.manual){fn.value=n;}if(!file.dataset.manual){file.value=n?`${n}.py`:'';}
      }
      if(source?.classList?.contains('te-function')||source?.classList?.contains('te-file'))source.dataset.manual='1';
      this.yamlEl.value=yamlFromDraft(this.draft());this.dirty=this.snapshot()!==this.initial;this.renderHeader();
    }
    addParam(p={name:'',type:'string',description:'',required:false}){const r=document.createElement('div');r.className='tool-editor-param';r.innerHTML=`<input class="p-name" placeholder="name" value="${esc(p.name)}"><select class="p-type"><option value="string">string</option><option value="integer">integer</option><option value="number">number</option><option value="boolean">boolean</option></select><input class="p-desc" placeholder="Description" value="${esc(p.description)}"><label title="Required"><input class="p-required" type="checkbox" ${p.required?'checked':''}> req</label><button type="button" class="danger p-remove">×</button>`;r.querySelector('.p-type').value=p.type||'string';r.querySelector('.p-remove').onclick=()=>{r.remove();this.changed()};for(const e of r.querySelectorAll('input,select'))e.oninput=()=>this.changed();this.paramsEl.appendChild(r)}
    fill(d,code){this.host.querySelector('.te-name').value=d.name||'';this.host.querySelector('.te-file').value=d.file||((d.name||'my_tool')+'.py');this.host.querySelector('.te-file').dataset.manual='1';this.host.querySelector('.te-label').value=d.label||'';this.host.querySelector('.te-description').value=d.description||'';this.host.querySelector('.te-function').value=d.function||d.name||'';this.host.querySelector('.te-function').dataset.manual='1';this.host.querySelector('.te-timeout').value=d.timeout_seconds||30;this.host.querySelector('.te-enabled').checked=!!d.enabled_by_default;this.paramsEl.innerHTML='';const props=d.parameters?.properties||{},req=new Set(d.parameters?.required||[]);for(const [name,s] of Object.entries(props))this.addParam({name,type:s.type||'string',description:s.description||'',required:req.has(name)});this.codeEl.value=code||defaultCode(d.name);this.yamlEl.value=yamlFromDraft(this.draft());this.initial=this.snapshot();this.dirty=false;this.renderHeader()}
    renderHeader(){const d=this.draft(),title=this.host.querySelector('.tool-editor-title'),sub=this.host.querySelector('.tool-editor-subtitle'),badges=this.host.querySelector('.tool-editor-badges');title.textContent=(d.name||'New tool')+(this.dirty?' *':'');sub.textContent=this.selected?'Saved external tool · edits are validated before hot-load':'New tool · not installed yet';badges.innerHTML=`<span>${this.selected?'external':'draft'}</span><span>${d.parameters.length} parameter${d.parameters.length===1?'':'s'}</span><span>${d.name?esc(d.name+'.yaml'):'YAML'}</span>`;this.host.querySelector('[data-action="save"]').disabled=!this.selected;this.host.querySelector('[data-action="delete"]').disabled=!this.selected}
    async guard(){return !this.dirty||confirm('Discard unsaved tool changes?')}
    async newTool(guard=true){if(guard&&!(await this.guard()))return;this.selected=null;const d=defaultDraft();this.fill({...d,file:'my_tool.py',parameters:{type:'object',properties:{argument:{type:'string',description:'Describe this argument.'}},required:['argument']}},defaultCode());this.initial='';this.dirty=true;this.renderHeader();this.setStatus('New tool draft. Define the schema and implementation, then Validate.');}
    async refresh(guard=true){if(guard&&!(await this.guard()))return;this.setStatus('Loading external tools…');try{const d=await request(API);this.tools=d.tools||[];this.renderList();this.setStatus(`${this.tools.length} external tool${this.tools.length===1?'':'s'} found.`,'ok')}catch(e){this.setStatus(e.message,'error')}}
    renderList(){const q=this.searchEl.value.trim().toLowerCase();const a=this.tools.filter(t=>!q||`${t.name} ${t.label} ${t.description}`.toLowerCase().includes(q));this.listEl.innerHTML='';for(const t of a){const b=document.createElement('button');b.className='skill-editor-list-item'+(this.selected===t.name?' active':'');b.innerHTML=`<span class="skill-editor-list-name">${esc(t.name)}</span><span class="skill-editor-list-desc">${esc(t.description||'')}</span><span class="skill-editor-list-meta">${t.loaded?'loaded':'invalid / unloaded'} · ${esc(t.definition_file||'')}</span>`;b.onclick=()=>this.load(t.name);this.listEl.appendChild(b)}if(!a.length)this.listEl.innerHTML='<div class="skill-editor-empty">No external tools yet.</div>'}
    async load(name){if(!(await this.guard()))return;this.setStatus(`Loading ${name}…`);try{const d=await request(`${API}/${encodeURIComponent(name)}`),t=d.tool;this.selected=name;this.fill(t.definition,t.code);this.yamlEl.value=t.yaml||yamlFromDraft(this.draft());this.renderList();this.setStatus(t.loaded?'Loaded and available.':'Saved but not loaded.','ok')}catch(e){this.setStatus(e.message,'error')}}
    async validate(){this.setStatus('Validating Python + generated YAML…');try{const d=await request(`${API}/validate`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({definition:this.definition(),code:this.codeEl.value})});this.yamlEl.value=d.yaml||this.yamlEl.value;this.setStatus(`Valid: ${d.definition.name}${d.exists?' · name already exists':''}.`,'ok');return d}catch(e){this.setStatus(e.message,'error');return null}}
    async save(existing){if(existing&&!this.selected)return;this.setStatus(existing?'Validating and hot-loading update…':'Validating and hot-loading new tool…');try{const url=existing?`${API}/${encodeURIComponent(this.selected)}`:`${API}/save`,method=existing?'PUT':'POST';const d=await request(url,{method,headers:{'Content-Type':'application/json'},body:JSON.stringify({definition:this.definition(),code:this.codeEl.value})});this.selected=d.tool.definition.name;this.fill(d.tool.definition,d.tool.code);this.yamlEl.value=d.tool.yaml||this.yamlEl.value;await this.refresh(false);this.renderList();this.setStatus(`Hot-loaded ${this.selected}. It is now available to Skills, Scheduled Tasks and Tiny Web Agent.`,'ok')}catch(e){this.setStatus(`Not installed: ${e.message}`,'error')}}
    async remove(){if(!this.selected||!confirm(`Delete external tool "${this.selected}"?`))return;try{await request(`${API}/${encodeURIComponent(this.selected)}`,{method:'DELETE'});this.selected=null;this.newTool(false);await this.refresh(false);this.setStatus('Tool deleted and registry reloaded.','ok')}catch(e){this.setStatus(e.message,'error')}}
  }
  window.ToolEditorWindow=ToolEditorWindow;window.openToolEditor=opts=>new ToolEditorWindow(opts||{});
})();
