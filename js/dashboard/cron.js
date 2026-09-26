(function(){
  const esc=v=>String(v??'').replace(/[&<>'"]/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#039;','"':'&quot;'}[ch]));
  const api=async(url,opts={})=>{const r=await fetch(url,{cache:'no-store',...opts,headers:{'Content-Type':'application/json',...(opts.headers||{})}});const d=await r.json().catch(()=>({error:`HTTP ${r.status}`}));if(!r.ok)throw new Error(d.error||`HTTP ${r.status}`);return d};
  const fmtWhen=ms=>ms?new Date(Number(ms)).toLocaleString([],{weekday:'short',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}):'—';
  const fmtRunTime=s=>s?new Date(s).toLocaleString([],{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}):'—';
  const WEEKDAYS=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const pad2=n=>String(Number(n)||0).padStart(2,'0');
  const timeLabel=(h,m)=>new Date(2000,0,1,Number(h)||0,Number(m)||0).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'});
  const toLocalInput=ms=>{const d=new Date(Number(ms)||Date.now()+3600000),p=n=>String(n).padStart(2,'0');return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`};

  function parseSchedule(job){
    const cfg=job?.config||{};
    if(cfg.schedule_kind==='once')return {kind:'once',onceAt:Number(cfg.once_at_ms)||Date.now()+3600000};
    const c=String(job?.cron||'0 9 * * *').trim();let m;
    if((m=c.match(/^\*\/(\d+) \* \* \* \*$/)))return {kind:'minutes',every:Number(m[1])};
    if((m=c.match(/^(\d+) \*\/(\d+) \* \* \*$/)))return {kind:'hours',every:Number(m[2]),minute:Number(m[1])};
    if((m=c.match(/^(\d+) (\d+) \* \* 1-5$/)))return {kind:'weekdays',time:`${pad2(m[2])}:${pad2(m[1])}`};
    if((m=c.match(/^(\d+) (\d+) \* \* ([0-6])$/)))return {kind:'weekly',weekday:Number(m[3]),time:`${pad2(m[2])}:${pad2(m[1])}`};
    if((m=c.match(/^(\d+) (\d+) (\d+) (\*|\*\/(\d+)) \*$/)))return {kind:'monthly',day:Number(m[3]),every:Number(m[5]||1),time:`${pad2(m[2])}:${pad2(m[1])}`};
    if((m=c.match(/^(\d+) (\d+) \* \* \*$/)))return {kind:'daily',time:`${pad2(m[2])}:${pad2(m[1])}`};
    return {kind:'advanced',cron:c};
  }
  function scheduleDescription(job){
    const s=parseSchedule(job);
    if(s.kind==='once')return `Once · ${fmtWhen(s.onceAt)}`;
    if(s.kind==='minutes')return `Every ${s.every} minute${s.every===1?'':'s'}`;
    if(s.kind==='hours')return `Every ${s.every} hour${s.every===1?'':'s'} at :${pad2(s.minute||0)}`;
    if(s.kind==='daily'){const [h,m]=s.time.split(':');return `Daily at ${timeLabel(h,m)}`}
    if(s.kind==='weekdays'){const [h,m]=s.time.split(':');return `Weekdays at ${timeLabel(h,m)}`}
    if(s.kind==='weekly'){const [h,m]=s.time.split(':');return `${WEEKDAYS[s.weekday]}s at ${timeLabel(h,m)}`}
    if(s.kind==='monthly'){const [h,m]=s.time.split(':');return `${s.every>1?`Every ${s.every} months`:'Monthly'} · day ${s.day} · ${timeLabel(h,m)}`}
    return 'Custom schedule';
  }
  function scheduleControls(job){
    const s=parseSchedule(job),kind=s.kind,time=s.time||'09:00';
    return `<div class="cron-schedule-builder">
      <div class="cron-row"><label><span>When</span><select class="task-frequency">
        <option value="once" ${kind==='once'?'selected':''}>Once</option><option value="minutes" ${kind==='minutes'?'selected':''}>Every N minutes</option><option value="hours" ${kind==='hours'?'selected':''}>Every N hours</option><option value="daily" ${kind==='daily'?'selected':''}>Every day</option><option value="weekdays" ${kind==='weekdays'?'selected':''}>Every weekday</option><option value="weekly" ${kind==='weekly'?'selected':''}>Every week</option><option value="monthly" ${kind==='monthly'?'selected':''}>Every N months</option><option value="advanced" ${kind==='advanced'?'selected':''}>Advanced</option>
      </select></label><label class="task-every-wrap"><span>Every</span><div class="cron-inline"><input class="task-every" type="number" min="1" max="59" value="${Number(s.every||1)}"><span class="task-unit">intervals</span></div></label></div>
      <div class="cron-row"><label class="task-once-wrap"><span>Date and time</span><input class="task-once" type="datetime-local" value="${esc(toLocalInput(s.onceAt))}"></label><label class="task-time-wrap"><span>Time</span><input class="task-time" type="time" value="${esc(time)}"></label><label class="task-minute-wrap"><span>Minute past hour</span><input class="task-minute" type="number" min="0" max="59" value="${Number(s.minute||0)}"></label></div>
      <div class="cron-row"><label class="task-weekday-wrap"><span>Day</span><select class="task-weekday">${WEEKDAYS.map((d,i)=>`<option value="${i}" ${Number(s.weekday??1)===i?'selected':''}>${d}</option>`).join('')}</select></label><label class="task-monthday-wrap"><span>Day of month</span><input class="task-monthday" type="number" min="1" max="31" value="${Number(s.day||1)}"></label></div>
      <label class="task-advanced-wrap"><span>Advanced cron</span><input class="task-expr" value="${esc(s.cron||job.cron||'0 9 * * *')}" spellcheck="false"><small>Only for schedules the menu cannot express.</small></label>
      <small class="task-schedule-summary">${esc(scheduleDescription(job))}</small></div>`;
  }
  function updateScheduleControls(root){
    const kind=root.querySelector('.task-frequency')?.value||'once';
    const show=(sel,on)=>{const x=root.querySelector(sel);if(x)x.hidden=!on};
    show('.task-every-wrap',['minutes','hours','monthly'].includes(kind));show('.task-once-wrap',kind==='once');show('.task-time-wrap',['daily','weekdays','weekly','monthly'].includes(kind));show('.task-minute-wrap',kind==='hours');show('.task-weekday-wrap',kind==='weekly');show('.task-monthday-wrap',kind==='monthly');show('.task-advanced-wrap',kind==='advanced');
    const unit=root.querySelector('.task-unit');if(unit)unit.textContent=kind==='minutes'?'minutes':kind==='hours'?'hours':kind==='monthly'?'months':'intervals';
    const every=root.querySelector('.task-every');if(every)every.max=kind==='monthly'?'12':'59';
    const summary=root.querySelector('.task-schedule-summary');if(summary){summary.textContent=buildSchedule(root).description;}
  }
  function buildSchedule(root){
    const kind=root.querySelector('.task-frequency')?.value||'once';
    if(kind==='once'){
      const ms=new Date(root.querySelector('.task-once')?.value||'').getTime();
      return {cron:'0 9 * * *',config:{schedule_kind:'once',once_at_ms:ms},description:Number.isFinite(ms)?`Once · ${fmtWhen(ms)}`:'Choose a date and time'};
    }
    const every=Math.max(1,Number(root.querySelector('.task-every')?.value||1)),minute=Math.max(0,Math.min(59,Number(root.querySelector('.task-minute')?.value||0)));
    const [hr,mn]=String(root.querySelector('.task-time')?.value||'09:00').split(':').map(Number);let cron='0 9 * * *';
    if(kind==='minutes')cron=`*/${Math.min(59,every)} * * * *`;else if(kind==='hours')cron=`${minute} */${Math.min(23,every)} * * *`;else if(kind==='daily')cron=`${mn||0} ${hr||0} * * *`;else if(kind==='weekdays')cron=`${mn||0} ${hr||0} * * 1-5`;else if(kind==='weekly')cron=`${mn||0} ${hr||0} * * ${Number(root.querySelector('.task-weekday')?.value||1)}`;else if(kind==='monthly'){const day=Math.max(1,Math.min(31,Number(root.querySelector('.task-monthday')?.value||1)));cron=`${mn||0} ${hr||0} ${day} ${every===1?'*':`*/${Math.min(12,every)}`} *`;}else cron=String(root.querySelector('.task-expr')?.value||'0 9 * * *').trim();
    return {cron,config:{schedule_kind:'recurring'},description:scheduleDescription({cron,config:{schedule_kind:'recurring'}})};
  }

  const actionLabel=j=>({reminder:'Reminder',launch_app:'Launch application',calendar_check:'Calendar check',ai_task:'Agent task'})[j?.config?.action_type]||(j?.job_type==='agent_prompt'?'Agent task':'Task');
  const managers=new Set();
  async function openRunInTinyAgent(runId){
    const d=await api(`/api/tasks/runs/${Number(runId)}/open-in-agent`,{method:'POST',body:'{}'});
    if(typeof TinyAgentWindow!=='function')throw new Error('Tiny Web Agent window is unavailable.');
    new TinyAgentWindow({conversationId:d.conversation_id});
    return d;
  }

  class ScheduledTasksWindow{
    constructor(opts={}){
      this.jobs=[];this.runs=[];this.apps=[];this.skills=[];this.tools=[];this.selectedId=opts.jobId||null;
      const n=document.createElement('div');n.className='cron-manager';n.innerHTML=`<header class="cron-header"><div><h2>Scheduled Tasks</h2><p>Choose what BrowserOS should do, what capabilities it may use, and when it should run.</p></div><button class="cron-new">+ New task</button></header><div class="cron-body"><aside class="cron-list"></aside><main class="cron-editor"><div class="cron-empty">Select a task or create a new one.</div></main></div><footer class="cron-footer"><span class="cron-status">Loading…</span></footer>`;
      document.body.appendChild(n);this.node=n;this.listEl=n.querySelector('.cron-list');this.editorEl=n.querySelector('.cron-editor');this.statusEl=n.querySelector('.cron-status');n.querySelector('.cron-new').onclick=()=>this.newTask();
      this.window=new ApplicationWindow({title:'Scheduled Tasks',label:`ScheduledTasks-${Date.now()}`,width:opts.width||'1000',height:opts.height||'760',launcher:{name:'ScheduledTasksWindow',opts:{}},mount:n,onclose:()=>{managers.delete(this);n.remove()}});managers.add(this);this.load();
    }
    setStatus(t,bad=false){this.statusEl.textContent=t;this.statusEl.classList.toggle('error',!!bad)}
    async load(){
      try{
        this.setStatus('Loading…');
        const [j,a,s,t]=await Promise.all([
          api('/api/tasks'),
          api('/api/apps').catch(()=>({apps:[]})),
          api('/api/os/skills').catch(()=>({skills:[]})),
          api('/api/os/tools').catch(()=>({tools:[]})),
        ]);
        this.jobs=j.jobs||[];this.apps=a.apps||[];this.skills=s.skills||[];this.tools=t.tools||[];
        this.renderList();
        if(this.selectedId&&this.jobs.some(x=>Number(x.id)===Number(this.selectedId)))await this.select(this.selectedId,false);else if(this.jobs[0])await this.select(this.jobs[0].id,false);else this.newTask();
        this.setStatus(`${this.jobs.length} scheduled task${this.jobs.length===1?'':'s'}.`);
      }catch(e){this.setStatus(e.message,true)}
    }
    renderList(){this.listEl.innerHTML=this.jobs.length?this.jobs.map(j=>`<button data-id="${j.id}" class="${Number(j.id)===Number(this.selectedId)?'active':''}"><span><b>${esc(j.name)}</b><small>${esc(actionLabel(j))} · ${esc(scheduleDescription(j))}</small></span><i class="${j.enabled?'on':'off'}">${j.running?'RUNNING':j.enabled?'ON':'OFF'}</i></button>`).join(''):'<div class="cron-empty">No tasks yet.</div>';this.listEl.querySelectorAll('[data-id]').forEach(b=>b.onclick=()=>this.select(Number(b.dataset.id)))}
    async select(id,rerender=true){this.selectedId=Number(id);if(rerender)this.renderList();const job=this.jobs.find(j=>Number(j.id)===this.selectedId);if(!job)return;const r=await api(`/api/tasks/runs?job_id=${job.id}&limit=10`).catch(()=>({runs:[]}));this.runs=r.runs||[];this.renderEditor(job,false)}
    newTask(){this.selectedId=null;this.renderList();this.runs=[];this.renderEditor({id:null,name:'New task',enabled:true,cron:'0 9 * * *',job_type:'task',handler:'reminder',prompt:'',config:{action_type:'reminder',message:'',notify:true,schedule_kind:'once',once_at_ms:Date.now()+3600000},miss_policy:'run_if_recent',max_lateness_minutes:120,next_run_ms:null},true)}

    aiFields(job){
      const c=job.config||{},mode=['auto','skill','tools','none'].includes(c.capability_mode)?c.capability_mode:'auto';
      const skillName=c.skill_name||'news';
      const checked=new Set(Array.isArray(c.tool_names)?c.tool_names:[]);
      const skills=this.skills.map(s=>`<option value="${esc(s.name)}" ${s.name===skillName?'selected':''}>${esc(s.name)} — ${esc(s.description)}</option>`).join('');
      const tools=this.tools.map(t=>`<label class="cron-enabled task-tool-item"><input type="checkbox" class="task-tool" value="${esc(t.name)}" ${checked.has(t.name)?'checked':''}><span><b>${esc(t.name)}</b>${t.description?`<small>${esc(t.description)}</small>`:''}</span></label>`).join('');
      return `<label><span>Task instructions</span><textarea class="task-ai" rows="6" placeholder="Describe what the agent should accomplish when this task runs.">${esc(c.instructions||job.prompt||'')}</textarea></label>
        <div class="task-capabilities"><span class="cron-field-title">Agent capabilities</span>
          <label><span>Mode</span><select class="task-cap-mode">
            <option value="auto" ${mode==='auto'?'selected':''}>Auto-select one Skill</option>
            <option value="skill" ${mode==='skill'?'selected':''}>Use a specific Skill</option>
            <option value="tools" ${mode==='tools'?'selected':''}>Choose tools manually</option>
            <option value="none" ${mode==='none'?'selected':''}>No tools · text only</option>
          </select></label>
          <div class="task-cap-auto" ${mode==='auto'?'':'hidden'}><small>Ministral sees the short installed-skill descriptions, selects one Skill, then runs the task with only that Skill's instructions and tools.</small></div>
          <label class="task-cap-skill" ${mode==='skill'?'':'hidden'}><span>Skill</span><select class="task-skill">${skills||'<option value="">No skills available</option>'}</select><small>Best for recurring jobs: pin a proven Skill so routing is skipped on every run.</small></label>
          <div class="task-cap-tools" ${mode==='tools'?'':'hidden'}><span>Tools</span><div class="task-tool-list">${tools||'<small>No BrowserOS tools are available.</small>'}</div><small>Keep this set small for Ministral. The agent sees only checked tools and no Skill procedure.</small></div>
          <div class="task-cap-none" ${mode==='none'?'':'hidden'}><small>No tools are exposed. Use only for rewriting, formatting, or tasks whose facts are already in the instructions.</small></div>
          <label><span>Maximum tool calls</span><input class="task-max-tools" type="number" min="0" max="12" value="${Math.max(0,Math.min(12,Number(c.max_tool_calls??6)))}"><small>A lower limit reduces latency and wandering on the 3B model.</small></label>
          <label><span>Maximum output tokens</span><input class="task-max-output" type="number" min="128" max="3000" step="64" value="${Math.max(128,Math.min(3000,Number(c.max_tokens??1600)))}"><small>Scheduled agent tasks previously defaulted to 500 tokens, which could cut longer results off mid-sentence. 1600 is the new default.</small></label>
          <label><span>Open completed result in</span><select class="task-result-view"><option value="tiny_agent" ${(c.result_view||'tiny_agent')==='tiny_agent'?'selected':''}>Tiny Web Agent</option><option value="history" ${c.result_view==='history'?'selected':''}>Scheduled Tasks history</option></select><small>The full result is always retained in task history either way.</small></label>
        </div>`;
    }
    actionFields(job){const c=job.config||{},type=c.action_type||'reminder';
      if(type==='reminder')return `<label><span>Reminder</span><textarea class="task-message" rows="3" placeholder="What should BrowserOS remind you about?">${esc(c.message||'')}</textarea></label>`;
      if(type==='launch_app')return `<label><span>Application</span><input class="task-app" list="task-app-list" value="${esc(c.app_query||c.app_name||'')}" placeholder="e.g. Spotify"><datalist id="task-app-list">${this.apps.slice(0,500).map(a=>`<option value="${esc(a.name)}"></option>`).join('')}</datalist><small>BrowserOS resolves the installed application when the task runs.</small></label>`;
      if(type==='calendar_check')return `<div class="cron-row"><label><span>Check</span><select class="task-period"><option value="today" ${c.period==='today'?'selected':''}>Today's calendar</option><option value="tomorrow" ${c.period==='tomorrow'?'selected':''}>Tomorrow's calendar</option><option value="next_7_days" ${c.period==='next_7_days'?'selected':''}>Next 7 days</option></select></label><label class="cron-enabled"><input class="task-use-ai" type="checkbox" ${c.use_ai?'checked':''}><span>Use Ministral to summarize</span></label></div><small>Without AI, BrowserOS reports the merged local/Outlook calendar directly.</small>`;
      return this.aiFields(job);
    }
    bindActionFields(job){
      const mode=this.editorEl.querySelector('.task-cap-mode');
      if(mode)mode.onchange=()=>{
        const root=this.editorEl.querySelector('.task-action-fields'),value=mode.value;
        root.querySelector('.task-cap-auto')?.toggleAttribute('hidden',value!=='auto');
        root.querySelector('.task-cap-skill')?.toggleAttribute('hidden',value!=='skill');
        root.querySelector('.task-cap-tools')?.toggleAttribute('hidden',value!=='tools');
        root.querySelector('.task-cap-none')?.toggleAttribute('hidden',value!=='none');
        const max=root.querySelector('.task-max-tools');if(max&&value==='none')max.value='0';else if(max&&Number(max.value)===0)max.value='6';
      };
    }
    runMetaLabel(r){const m=r.meta||{},limit=m.finish_reason==='length'?' · output limit reached':'';if(m.inference_lane==='deterministic')return 'Deterministic';const skill=m.skill?.name||'';if(skill)return `Skill: ${skill}${m.tool_calls!=null?` · ${m.tool_calls} tool call${Number(m.tool_calls)===1?'':'s'}`:''}${limit}`;if(m.capability_mode==='tools')return `Manual tools${m.tool_calls!=null?` · ${m.tool_calls} calls`:''}${limit}`;if(m.inference_lane)return `LLM${limit}`;return ''}
    renderEditor(job,isNew=false){
      const c=job.config||{},type=c.action_type||(job.job_type==='agent_prompt'?'ai_task':'reminder');
      const runs=this.runs.map(r=>`<details class="cron-run ${esc(r.status)}"><summary><b>${esc(r.status.toUpperCase())}</b><span>${esc(fmtRunTime(r.started_at))}</span><small>${esc(this.runMetaLabel(r))}</small></summary><div>${r.error?`<p class="cron-run-error">${esc(r.error)}</p>`:`<pre>${esc(r.result||'(no output)')}</pre>${r.status==='success'?`<div class="task-run-actions"><button type="button" data-open-agent-run="${Number(r.id)}">Open in Tiny Web Agent</button></div>`:''}`}</div></details>`).join('')||'<div class="cron-empty">No runs yet.</div>';
      this.editorEl.innerHTML=`<div class="cron-fields"><label><span>Task name</span><input class="task-name" value="${esc(job.name)}"></label><label><span>What should happen?</span><select class="task-type"><option value="reminder" ${type==='reminder'?'selected':''}>Reminder</option><option value="launch_app" ${type==='launch_app'?'selected':''}>Launch an application</option><option value="calendar_check" ${type==='calendar_check'?'selected':''}>Check calendar</option><option value="ai_task" ${type==='ai_task'?'selected':''}>Agent task</option></select></label><div class="task-action-fields">${this.actionFields({...job,config:{...c,action_type:type}})}</div><div><span class="cron-field-title">Schedule</span>${scheduleControls(job)}</div><div class="cron-row"><label><span>If the computer was asleep</span><select class="task-miss"><option value="run_if_recent" ${job.miss_policy==='run_if_recent'?'selected':''}>Run if still recent</option><option value="run_once" ${job.miss_policy==='run_once'?'selected':''}>Run when BrowserOS resumes</option><option value="skip" ${job.miss_policy==='skip'?'selected':''}>Skip missed run</option></select></label><label><span>Still recent for</span><div class="cron-inline"><input class="task-late" type="number" min="1" max="1440" value="${Number(job.max_lateness_minutes||120)}"><span>minutes</span></div></label></div><label class="cron-enabled"><input class="task-notify" type="checkbox" ${c.notify!==false?'checked':''}><span>Show result as a BrowserOS notification</span></label><label class="cron-enabled"><input class="task-enable" type="checkbox" ${job.enabled?'checked':''}><span>Task enabled</span></label></div><div class="cron-actions"><button class="task-save">${isNew?'Create task':'Save'}</button>${!isNew?`<button class="task-run" ${job.running?'disabled':''}>${job.running?'Running…':'Run now'}</button><button class="task-delete danger">Delete</button>`:''}<span>Next: ${esc(fmtWhen(job.next_run_ms))}</span></div><section class="cron-history"><header><strong>Run history</strong>${!isNew&&this.runs.length?`<button type="button" class="task-clear-history danger">Clear history</button>`:''}</header>${runs}</section>`;
      this.editorEl.querySelectorAll('.task-frequency,.task-every,.task-once,.task-time,.task-minute,.task-weekday,.task-monthday,.task-expr').forEach(x=>x.addEventListener('input',()=>updateScheduleControls(this.editorEl)));this.editorEl.querySelector('.task-frequency')?.addEventListener('change',()=>updateScheduleControls(this.editorEl));updateScheduleControls(this.editorEl);
      this.bindActionFields(job);
      this.editorEl.querySelector('.task-type').onchange=()=>{const draft={...job,config:{...(job.config||{}),action_type:this.editorEl.querySelector('.task-type').value}};this.editorEl.querySelector('.task-action-fields').innerHTML=this.actionFields(draft);this.bindActionFields(draft)};
      this.editorEl.querySelector('.task-save').onclick=()=>this.save(job,isNew);this.editorEl.querySelector('.task-run')?.addEventListener('click',()=>this.runNow(job));this.editorEl.querySelector('.task-delete')?.addEventListener('click',()=>this.delete(job));;this.editorEl.querySelector('.task-clear-history')?.addEventListener('click',()=>this.clearHistory(job));
      this.editorEl.querySelectorAll('[data-open-agent-run]').forEach(b=>b.onclick=async e=>{e.preventDefault();e.stopPropagation();try{this.setStatus('Opening result in Tiny Web Agent…');await openRunInTinyAgent(Number(b.dataset.openAgentRun));this.setStatus('Opened result in Tiny Web Agent.')}catch(err){this.setStatus(err.message,true)}});
    }
    payload(job){
      const type=this.editorEl.querySelector('.task-type').value,schedule=buildSchedule(this.editorEl),config={...(job.config||{}),...schedule.config,action_type:type,notify:this.editorEl.querySelector('.task-notify').checked};
      if(type==='reminder')config.message=this.editorEl.querySelector('.task-message')?.value.trim()||'';
      if(type==='launch_app')config.app_query=this.editorEl.querySelector('.task-app')?.value.trim()||'';
      if(type==='calendar_check'){config.period=this.editorEl.querySelector('.task-period')?.value||'today';config.use_ai=!!this.editorEl.querySelector('.task-use-ai')?.checked}
      if(type==='ai_task'){
        config.instructions=this.editorEl.querySelector('.task-ai')?.value.trim()||'';
        config.capability_mode=this.editorEl.querySelector('.task-cap-mode')?.value||'auto';
        config.skill_name=this.editorEl.querySelector('.task-skill')?.value||'';
        config.tool_names=[...this.editorEl.querySelectorAll('.task-tool:checked')].map(x=>x.value);
        config.max_tool_calls=Math.max(0,Math.min(12,Number(this.editorEl.querySelector('.task-max-tools')?.value||0)));
        config.max_tokens=Math.max(128,Math.min(3000,Number(this.editorEl.querySelector('.task-max-output')?.value||1600)));
        config.result_view=this.editorEl.querySelector('.task-result-view')?.value||'tiny_agent';
      }
      return {name:this.editorEl.querySelector('.task-name').value.trim(),cron:schedule.cron,enabled:this.editorEl.querySelector('.task-enable').checked,miss_policy:this.editorEl.querySelector('.task-miss').value,max_lateness_minutes:Number(this.editorEl.querySelector('.task-late').value||120),job_type:'task',handler:type,prompt:type==='ai_task'?config.instructions:'',config};
    }
    async save(job,isNew){
      try{
        this.setStatus(isNew?'Creating task…':'Saving…');const body=this.payload(job),c=body.config;
        if(c.action_type==='reminder'&&!c.message)throw new Error('Enter a reminder message.');
        if(c.action_type==='launch_app'&&!c.app_query)throw new Error('Choose an application.');
        if(c.action_type==='ai_task'&&!c.instructions)throw new Error('Enter agent task instructions.');
        if(c.action_type==='ai_task'&&c.capability_mode==='skill'&&!c.skill_name)throw new Error('Choose a Skill.');
        if(c.action_type==='ai_task'&&c.capability_mode==='tools'&&c.tool_names.length>12)throw new Error('Choose at most 12 tools.');
        const d=await api(isNew?'/api/tasks':`/api/tasks/${job.id}`,{method:isNew?'POST':'PUT',body:JSON.stringify(body)});this.selectedId=d.job.id;await this.load();this.setStatus(`Saved ${d.job.name}.`);
      }catch(e){this.setStatus(e.message,true)}
    }
    async runNow(job){try{this.setStatus(`Starting ${job.name}…`);await api(`/api/tasks/${job.id}/run`,{method:'POST',body:'{}'});const i=this.jobs.findIndex(x=>Number(x.id)===Number(job.id));if(i>=0)this.jobs[i]={...this.jobs[i],running:true};this.renderList();this.renderEditor({...job,running:true});this.setStatus(`${job.name} is running…`)}catch(e){this.setStatus(e.message,true)}}
    async delete(job){if(!confirm(`Delete scheduled task “${job.name}”?`))return;try{await api(`/api/tasks/${job.id}`,{method:'DELETE'});this.selectedId=null;await this.load()}catch(e){this.setStatus(e.message,true)}}
    async clearHistory(job){if(!this.runs.length)return;if(!confirm(`Clear all saved run history for “${job.name}”?\n\nThis will not delete the task or any Tiny Web Agent conversations opened from previous results.`))return;try{this.setStatus('Clearing run history…');const d=await api(`/api/tasks/${job.id}/runs`,{method:'DELETE'});this.runs=[];this.renderEditor(job);const n=Number(d.cleared||0);this.setStatus(`Cleared ${n} run${n===1?'':'s'} from ${job.name}.`)}catch(e){this.setStatus(e.message,true)}}
    handleEvent(event){const job=event?.job;if(!job)return;const i=this.jobs.findIndex(x=>Number(x.id)===Number(job.id));if(i>=0)this.jobs[i]=job;else this.jobs.push(job);this.renderList();if(Number(this.selectedId)===Number(job.id)){if(event.run)this.runs=[event.run,...this.runs.filter(r=>Number(r.id)!==Number(event.run.id))].slice(0,10);this.renderEditor(job);const bad=event.type==='task_error';this.setStatus(bad?`${job.name} failed.`:`${job.name} finished.`,bad)}}
  }

  function toast(event){const job=event.job||{},run=event.run||{},cfg=job.config||{};if(cfg.notify===false)return;const failed=event.type==='task_error'||run.status==='error',text=failed?(run.error||'Scheduled task failed.'):(run.result||'Scheduled task completed.');const old=document.querySelector('.bos-cron-toast');if(old)old.remove();const n=document.createElement('div');n.className='bos-cron-toast';n.innerHTML=`<strong>${esc(job.name||'Scheduled task')}</strong><span>${esc(text.slice(0,300))}</span><div><button class="task-toast-open">Open</button><button class="task-toast-dismiss">Dismiss</button></div>`;document.body.appendChild(n);n.querySelector('.task-toast-dismiss').onclick=()=>n.remove();n.querySelector('.task-toast-open').onclick=async()=>{n.remove();if(!failed&&run.id&&(cfg.result_view||'tiny_agent')==='tiny_agent'){try{await openRunInTinyAgent(run.id)}catch(e){console.warn('Could not open scheduled result in Tiny Web Agent',e);new ScheduledTasksWindow({jobId:job.id})}}else new ScheduledTasksWindow({jobId:job.id})};try{if(Notification.permission==='granted')new Notification(job.name||'BrowserOS scheduled task',{body:text.slice(0,180)})}catch{}}
  const ScheduledTaskNotifications={source:null,init(){if(this.source)return;try{this.source=new EventSource('/api/tasks/events');this.source.onmessage=e=>{try{const event=JSON.parse(e.data);managers.forEach(m=>m.handleEvent(event));toast(event);window.dispatchEvent(new CustomEvent('browseros:scheduled-task-event',{detail:event}))}catch{}}}catch{}}};ScheduledTaskNotifications.init();
  window.ScheduledTasksWindow=ScheduledTasksWindow;
  window.CronManagerWindow=ScheduledTasksWindow;
  window.BrowserOSScheduledTaskNotifications=ScheduledTaskNotifications;
})();
