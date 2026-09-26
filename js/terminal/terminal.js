class Terminal {
  constructor(id) {
    this.id = id;
    this.cmdLineId = `#cmdline-${id}`;
    this.cmdLine_ = document.querySelector(this.cmdLineId);
    this.outputId = `#output-${id}`;
    this.output_ = document.querySelector(this.outputId);
    this.terminalWindow = document.querySelector(`#terminal-window-${id}`);
    this.prompt = document.querySelector(`#prompt-${id}`);
    this.history_ = [];
    this.histpos_ = 0;
    this.histtemp_ = '';
    this.terminalShortcuts_ = {};
    this.traceControls_ = null;
    this.osMode_ = false;
    this.devMode_ = false;
    this.devSessionId_ = null;
    this.osSessionId_ = null;
    this.osModeHistory_ = [];
    this.skill_ = null;

    this.helpMsgs = {
      system: {
        help: 'Displays this message',
        clear: 'Clears the console and resets the OS model context',
        date: 'Displays the current date',
        echo: 'Outputs text. Usage: echo Hello World',
        system: 'Opens the system resource monitor',
        ecosystem: 'Opens the interactive tiny ecosystem',
        tamagotchi: 'Opens the persistent pixel pet',
        news: 'Opens the RSS news window',
        weather: 'Opens weather',
        agenda: 'Opens Outlook agenda',
        processes: 'Shows top processes',
        network: 'Opens network monitor',
        disks: 'Opens disk-space monitor',
        services: 'Checks configured local services',
        refresh: 'Refreshes system data now',
        whoami: 'Displays browser and local Browser-OS information'
      },
      web: {
        open: 'Opens a desktop shortcut or URL. Usage: open github',
        search: 'Searches the web. Usage: search browser os dashboard',
        shortcuts: 'Lists desktop shortcuts',
        addshortcut: 'Creates a new desktop shortcut',
        alias: 'Adds persistent website command(s). Usage: alias yt,y https://youtube.com',
        unalias: 'Removes persistent website command(s). Usage: unalias yt,y',
        aliases: 'Lists persistent terminal website shortcuts',
        bookmarks: 'Opens bookmark manager',
        launch: 'Launches a native app by name (fuzzy matching). Usage: launch steam; plain launch opens the app launcher',
        notes: 'Opens scratchpad notes',
        todo: 'Opens todo list',
        clipboard: 'Opens clipboard history',
        timer: 'Opens timers and future reminders',
        palette: 'Opens the command palette',
        riftbreakers: 'Opens the Riftbreakers 2e Virtual Tabletop',
        geomancy: 'Opens the geomantic Shield & House Chart',
        ai: 'Opens Tiny Web Agent chat (general chat context)',
        os: 'Runs one OS-agent request, or toggles Agent mode. Usage: os [on|off|status|instruction]',
        devmode: 'Toggles persistent development-agent mode with project editing tools. Usage: devmode [on|off|status]',
        skill: 'Lists or manually selects an OS-agent skill. Usage: skill [auto|name]',
        skilleditor: 'Opens the BrowserOS Skills Editor',
        tooleditor: 'Opens the BrowserOS Tool Editor',
        cron: 'Opens Scheduled Tasks',
        tasks: 'Opens Scheduled Tasks',
        reminders: 'Opens Scheduled Tasks',
        agentmode: 'Toggles persistent terminal Agent mode so normal lines are sent to the OS agent',
        osagent: 'Alias for os <instruction>',
        research: 'Researches the web using 3–5 compact sources. Usage: research your question'
      },
      desktop: {
        terminal: 'Opens another Terminal window',
        minimize: 'Minimizes all Browser-OS windows',
        restore: 'Restores all Browser-OS windows',
        background: 'Opens Background settings, or sets an image URL. Usage: background [https://...]',
        appearance: 'Opens WinBox appearance settings'
      }
    };

    this.commands = {
      help: args => this.runHelp(args),
      clear: async () => this.clear(),
      echo: args => this.output(args.join(' ')),
      date: () => this.output(new Date()),
      system: () => { new SystemWindow(); return true; },
      ecosystem: () => { new EcosystemWindow(); return true; },
      tamagotchi: () => { new TamagotchiWindow(); return true; },
      tama: () => { new TamagotchiWindow(); return true; },
      news: () => { new NewsWindow(); return true; },
      weather: () => { new WeatherWindow(); return true; },
      agenda: () => { new CalendarWindow(); return true; },
      processes: () => { new ProcessesWindow(); return true; },
      network: () => { new NetworkWindow(); return true; },
      disks: () => { new DisksWindow(); return true; },
      services: () => { new ServicesWindow(); return true; },
      launch: args => this.launchApp(args),
      notes: () => { new NotesWindow(); return true; },
      todo: () => { new TodoWindow(); return true; },
      clipboard: () => { new ClipboardWindow(); return true; },
      bookmarks: () => { new BookmarksWindow(); return true; },
      timer: () => { new TimerWindow(); return true; },
      palette: () => { CommandPalette.open(); return true; },
      riftbreakers: () => { new RiftbreakersWindow(); return true; },
      geomancy: () => { new GeomancyWindow(); return true; },
      ai: () => { new TinyAgentWindow(); return true; },
      agent: () => { new TinyAgentWindow(); return true; },
      os: async args => this.handleOsEntry(args, 'os'),
      devmode: async args => this.setDevMode(args),
      skill: async args => this.setSkill(args),
      skilleditor: () => { new SkillEditorWindow(); return true; },
      tooleditor: () => { new ToolEditorWindow(); return true; },
      cron: () => { new ScheduledTasksWindow(); return true; },
      tasks: () => { new ScheduledTasksWindow(); return true; },
      reminders: () => { new ScheduledTasksWindow(); return true; },
      agentmode: async args => this.setOsMode(args),
      osagent: async args => this.runOsCommand(args, 'osagent'),
      research: async args => this.runResearchCommand(args),
      vtt: () => { new RiftbreakersWindow(); return true; },
      terminal: () => { new TerminalWindow(); return true; },
      refresh: async () => { await SystemMonitor.refresh(); this.output('System data refreshed.'); return true; },
      whoami: () => this.whoami(),
      open: args => this.open(args),
      search: args => this.search(args),
      shortcuts: () => this.shortcuts(),
      addshortcut: () => { ShortcutManager.promptAdd(); return true; },
      alias: async args => this.addTerminalAlias(args),
      unalias: async args => this.removeTerminalAlias(args),
      aliases: async () => this.listTerminalAliases(),
      minimize: () => { minimizeAllWindows(); return true; },
      restore: () => { restoreAllWindows(); return true; },
      background: args => this.background(args),
      appearance: () => { new AppearanceWindow(); return true; }
    };
  }

  init() {
    // Remove the retired global Direct LLM preference. Voice dictation now
    // marks only the next submitted terminal line as an OS-agent request.
    localStorage.removeItem('browseros.directLlmMode');
    this.defineKeyEventListeners();
    this.initTerminalMsg();
    this.setPromptDecoration('[browser-os@local]');
    this.refreshTerminalAliases();
  }

  escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  formatOsToolName(name) {
    const labels = {
      duckduckgo_search: 'DuckDuckGo search',
      cbc_top_stories: 'News',
      browser_window: 'Window control',
      browser_system_info: 'System information',
      browser_note: 'Notes',
      browser_todo: 'Todo',
      browser_timer: 'Timer',
      browser_launch_app: 'App launcher',
      browser_research: 'Web research',
      browser_read_url: 'Read URL',
      browser_project_list: 'Project files',
      browser_project_read: 'Read project file',
      browser_project_find: 'Search project source',
      browser_project_replace: 'Edit project file',
      browser_project_write: 'Write project file',
      browser_project_check: 'Check project file',
      browser_project_npm: 'npm package'
    };
    return labels[name] || String(name || 'Tool');
  }

  formatOsToolArguments(args) {
    const entries = Object.entries(args || {});
    if (!entries.length) return '<span class="muted">no arguments</span>';
    return entries.map(([key,value]) => {
      const rendered = typeof value === 'string' ? value : JSON.stringify(value);
      return `<span class="muted">${this.escapeHtml(key)}:</span> ${this.escapeHtml(rendered)}`;
    }).join(' &nbsp; ');
  }

  ensureTraceControls() {
    if (this.traceControls_ && this.traceControls_.isConnected) return this.traceControls_;
    const bar = document.createElement('div');
    bar.className = 'terminal-trace-controls';
    bar.innerHTML = '<button type="button" data-trace-action="expand">Expand all</button><button type="button" data-trace-action="collapse">Collapse all</button>';
    bar.addEventListener('click', event => {
      const action = event.target?.dataset?.traceAction;
      if (!action) return;
      this.output_.querySelectorAll('details.terminal-trace').forEach(item => { item.open = action === 'expand'; });
      this.cmdLine_.focus();
    });
    this.output_.appendChild(bar);
    this.traceControls_ = bar;
    return bar;
  }

  outputCollapsibleTrace(summaryHtml, bodyHtml, {open=false, className=''}={}) {
    this.ensureTraceControls();
    const details = document.createElement('details');
    details.className = `terminal-trace ${className}`.trim();
    details.open = !!open;
    const summary = document.createElement('summary');
    summary.innerHTML = summaryHtml;
    const body = document.createElement('div');
    body.className = 'terminal-trace-body';
    body.innerHTML = bodyHtml;
    details.append(summary, body);
    this.output_.appendChild(details);
    this.cmdLine_.focus();
    this.cmdLine_.scrollIntoView();
    return details;
  }

  handleOsAgentEvent(event) {
    if (!event || !event.event) return;
    if (event.event === 'token') {
      const text = String(event.text || '');
      if (!text) return;
      if (!this._osStreamNode) {
        const row = document.createElement('p');
        row.className = 'os-stream-response';
        row.innerHTML = '<strong>OS&gt;</strong> <span class="os-stream-text"></span><span class="os-stream-cursor">▌</span>';
        this.output_.appendChild(row);
        this._osStreamNode = row;
        this._osStreamText = row.querySelector('.os-stream-text');
        this._osStreamBuffer = '';
      }
      this._osStreamBuffer += text;
      this._osStreamText.textContent = this._osStreamBuffer;
      this.cmdLine_.scrollIntoView();
      return;
    }
    if (event.event === 'skill_selection_start') {
      const mode=event.mode==='manual'?'manual':event.mode==='devmode'?'devmode':'auto';
      this.output(`<span class="muted">[skill]</span> ${mode==='auto'?'Ministral selecting procedure…':`Using ${this.escapeHtml(mode)} selection…`}`);
      return;
    }
    if (event.event === 'skill_selected') {
      this.output(`<span class="muted">[skill]</span> ${this.escapeHtml(event.skill || 'general')} — ${this.escapeHtml(event.description || '')} <span class="muted">(${this.escapeHtml(event.selection_mode||'auto')})</span>`);
      return;
    }
    if (event.event === 'model_loading') {
      this.output(`<span class="muted">[model]</span> Loading ${this.escapeHtml(event.name || 'model')}…`);
      return;
    }
    if (event.event === 'model_loaded') {
      const extra = event.seconds != null ? ` in ${Number(event.seconds).toFixed(2)}s` : '';
      this.output(`<span class="muted">[model]</span> ${this.escapeHtml(event.name || 'Model')} ready${extra}.`);
      return;
    }
    if (event.event === 'inference_start') {
      const context = event.estimated_context_tokens != null ? ` · ~${Number(event.estimated_context_tokens).toLocaleString()} context tokens` : '';
      const tools = event.tools != null ? ` · ${event.tools} tools available` : '';
      this.output(`<span class="muted">[thinking]</span>${context}${tools}`);
      return;
    }
    if (event.event === 'tool_start') {
      this.finishOsStreamLine();
      this.outputCollapsibleTrace(
        `<strong>[tool ${event.sequence || '?'}] ${this.escapeHtml(this.formatOsToolName(event.name))}</strong>`,
        this.formatOsToolArguments(event.arguments),
        {className:'tool-call-trace'}
      );
      return;
    }
    if (event.event === 'tool_end') {
      const duration = event.duration_seconds != null ? ` · ${Number(event.duration_seconds).toFixed(3)}s` : '';
      let result = String(event.result ?? '').trim();
      if (result.length > 500) result = result.slice(0, 500) + '…';
      const failed = /^Tool (error|is disabled)/i.test(result);
      this.outputCollapsibleTrace(
        `<span class="muted">[tool ${event.sequence || '?'} result${duration}]</span>${failed ? ' <strong>FAILED</strong>' : ''}`,
        `${failed ? '<strong>FAILED:</strong> ' : ''}${this.escapeHtml(result || 'Completed.')}`,
        {className: failed ? 'tool-result-trace failed' : 'tool-result-trace'}
      );
      return;
    }
  }

  finishOsStreamLine() {
    if (this._osStreamNode) {
      this._osStreamNode.querySelector('.os-stream-cursor')?.remove();
      this._osStreamNode = null;
      this._osStreamText = null;
      this._osStreamBuffer = '';
    }
  }

  async setOsMode(args=[]) {
    const requested=String(args[0]||'').toLowerCase();
    let enabled=this.osMode_;
    if(requested==='on')enabled=true;
    else if(requested==='off')enabled=false;
    else if(requested==='status'){this.output(`OS Agent mode is <strong>${this.osMode_?'ON':'OFF'}</strong>.`);return true;}
    else enabled=!enabled;
    this.osMode_=enabled;
    if(enabled && !this.osSessionId_) this.osSessionId_=(globalThis.crypto?.randomUUID?.() || `os-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    if(!enabled){this.devMode_=false;this.osSessionId_=null;}
    this.osModeHistory_=[];
    this.setPromptDecoration(enabled?(this.devMode_?'[DEV AGENT]':'[OS AGENT]'):'[browser-os@local]');
    this.output(enabled
      ? '<strong>OS Agent mode ON.</strong> Type normally; /exit or <code>os off</code> returns to the shell.'
      : '<strong>OS Agent mode OFF.</strong> Terminal shell restored.');
    return true;
  }



  async setDevMode(args=[]) {
    const requested=String(args[0]||'').toLowerCase();
    if(requested==='status'){
      this.output(`Dev Agent mode is <strong>${this.devMode_?'ON':'OFF'}</strong>.`);
      return true;
    }
    let enabled=this.devMode_;
    if(requested==='on')enabled=true;
    else if(requested==='off')enabled=false;
    else enabled=!enabled;
    this.devMode_=enabled;
    this.osMode_=enabled;
    this.osSessionId_=enabled ? (globalThis.crypto?.randomUUID?.() || `os-${Date.now()}-${Math.random().toString(16).slice(2)}`) : null;
    this.devSessionId_=enabled
      ? (globalThis.crypto?.randomUUID?.() || `dev-${Date.now()}-${Math.random().toString(16).slice(2)}`)
      : null;
    this.osModeHistory_=[];
    this.setPromptDecoration(enabled?'[DEV AGENT]':'[browser-os@local]');
    this.output(enabled
      ? '<strong>Dev Agent mode ON.</strong> Project development tools are forced on. Type normally; /exit or <code>devmode off</code> returns to the shell.'
      : '<strong>Dev Agent mode OFF.</strong> Terminal shell restored.');
    return true;
  }

  async setSkill(args=[]) {
    const requested=String(args[0]||'').trim().toLowerCase();
    let skills=[];
    try{skills=await BrowserOSSkills.list()}catch(error){this.output(`<strong>Skill list error:</strong> ${this.escapeHtml(error.message||error)}`);return false}
    if(!requested){
      const current=this.devMode_?'browser-os-dev (forced by devmode)':(this.skill_||'auto (Ministral chooses)');
      this.output(`<strong>Current skill:</strong> ${this.escapeHtml(current)}`);
      this.output(skills.map(s=>`<code>${this.escapeHtml(s.name)}</code> — ${this.escapeHtml(s.description)}`).join('<br>'));
      return true;
    }
    if(['auto','none','off','reset'].includes(requested)){
      this.skill_=null;
      this.output('<strong>Skill selection:</strong> auto. Ministral will choose from retrieved candidates.');
      return true;
    }
    const found=skills.find(s=>String(s.name).toLowerCase()===requested);
    if(!found){
      this.output(`Unknown skill: <code>${this.escapeHtml(requested)}</code>. Use <code>skill</code> to list available skills.`);
      return false;
    }
    this.skill_=found.name;
    this.output(`<strong>Manual skill selected:</strong> <code>${this.escapeHtml(found.name)}</code> — ${this.escapeHtml(found.description)}`);
    if(this.devMode_)this.output('<span class="muted">Note: devmode currently overrides manual selection with browser-os-dev.</span>');
    return true;
  }

  async handleOsEntry(args, commandName='os') {
    const first=String(args[0]||'').toLowerCase();
    if(!args.length || ['on','off','status'].includes(first))return this.setOsMode(args);
    return this.runOsCommand(args,commandName,false);
  }

  agentPrompt(text){
    const recent=this.osModeHistory_.slice(-6);
    if(!recent.length)return text;
    const history=recent.map(m=>`${m.role==='user'?'User':'Assistant'}: ${String(m.text||'').slice(0,700)}`).join('\n');
    return `RECENT CONVERSATION:\n${history}\n\nCURRENT USER: ${text}`;
  }

  async runOsCommand(args, commandName='os', useHistory=false) {
    if (!args.length) { this.output(`Usage: ${commandName} <Browser-OS instruction>`); return false; }
    const userText=args.join(' ');
    // Conversation continuity is maintained by the backend using osSessionId_.
    // Do not paste a synthetic transcript into each new user prompt.
    const requestText=userText;
    this.output('<span class="muted">OS agent started.</span>');
    this.finishOsStreamLine();
    const result = await BrowserOSAgent.queryStream(requestText, event => this.handleOsAgentEvent(event), {
      devmode:this.devMode_,
      devsession:this.devMode_ ? this.devSessionId_ : null,
      ossession:this.osSessionId_,
      skill:this.devMode_ ? 'browser-os-dev' : this.skill_
    });
    const streamed = !!this._osStreamNode;
    this.finishOsStreamLine();
    if (!streamed && result.response) this.output(`<strong>OS&gt;</strong> ${this.escapeHtml(result.response)}`);
    else if (!streamed && !result.response) this.output(`Done (${result.tool_calls || 0} action${result.tool_calls===1?'':'s'}).`);
    if(window.BrowserOSSkills?.canTeach(result.tool_traces)){
      const row=document.createElement('p');
      row.className='skill-teach-offer';
      row.appendChild(BrowserOSSkills.makeTeachButton({task:userText,response:result.response||'',tool_traces:result.tool_traces||[],selected_skill:result.skill||null}));
      this.output_.appendChild(row);
      this.cmdLine_.scrollIntoView();
    }
    if(useHistory){this.osModeHistory_.push({role:'user',text:userText},{role:'assistant',text:String(result.response||'')});this.osModeHistory_=this.osModeHistory_.slice(-8);}
    return true;
  }

  handleResearchEvent(event) {
    if (!event || !event.event) return;
    if (event.event === 'research_search_start') {
      this.output(`<span class="muted">[research]</span> Searching web candidates…`); return;
    }
    if (event.event === 'research_sources') {
      const n=Number(event.sources_selected||0), toks=Number(event.estimated_evidence_tokens||0);
      const sources=(event.sources||[]).map(src => {
        const title=this.escapeHtml(src.title||'Untitled source');
        const domain=this.escapeHtml(src.domain||'');
        const url=this.escapeHtml(src.url||'');
        return `<div class="terminal-trace-source"><span class="muted">[${this.escapeHtml(src.index)}]</span> ${title}${domain ? ` <span class="muted">— ${domain}</span>` : ''}${url ? `<br><span class="terminal-trace-url">${url}</span>` : ''}</div>`;
      }).join('');
      this.outputCollapsibleTrace(
        `<span class="muted">[research]</span> ${n} source${n===1?'':'s'} · ~${toks.toLocaleString()} evidence tokens`,
        sources || '<span class="muted">No source metadata.</span>',
        {className:'research-evidence-trace'}
      );
      return;
    }
    if (event.event === 'model_loading') { this.output(`<span class="muted">[model]</span> Loading ${this.escapeHtml(event.name||'model')}…`); return; }
    if (event.event === 'model_loaded') { const x=event.seconds!=null?` in ${Number(event.seconds).toFixed(2)}s`:''; this.output(`<span class="muted">[model]</span> ${this.escapeHtml(event.name||'Model')} ready${x}.`); return; }
    if (event.event === 'inference_start') { const c=event.estimated_context_tokens!=null?` · ~${Number(event.estimated_context_tokens).toLocaleString()} context tokens`:''; this.output(`<span class="muted">[thinking]</span>${c}`); return; }
    if (event.event === 'token') {
      const text=String(event.text||''); if(!text)return;
      if(!this._researchStreamNode){
        const row=document.createElement('p'); row.className='research-stream-response';
        row.innerHTML='<strong>Research&gt;</strong> <span class="research-stream-text"></span><span class="research-stream-cursor">▌</span>';
        this.output_.appendChild(row); this._researchStreamNode=row; this._researchStreamText=row.querySelector('.research-stream-text'); this._researchStreamBuffer='';
      }
      this._researchStreamBuffer+=text; this._researchStreamText.textContent=this._researchStreamBuffer; this.cmdLine_.scrollIntoView(); return;
    }
  }

  finishResearchStreamLine() {
    if(this._researchStreamNode){this._researchStreamNode.querySelector('.research-stream-cursor')?.remove();}
    this._researchStreamNode=null;this._researchStreamText=null;this._researchStreamBuffer='';
  }

  async runResearchCommand(args) {
    if(!args.length){this.output('Usage: research <question>');return false;}
    this.output('<span class="muted">Research started.</span>'); this.finishResearchStreamLine();
    const result=await BrowserOSResearch.stream(args.join(' '),e=>this.handleResearchEvent(e),4);
    const streamed=!!this._researchStreamNode; this.finishResearchStreamLine();
    if(!streamed && result.response)this.output(`<strong>Research&gt;</strong> ${this.escapeHtml(result.response)}`);
    return true;
  }

  setPromptDecoration(decoration='[browser-os@local]') { this.prompt.innerHTML = decoration; }

  initTerminalMsg() {
    this.output(`<div class="date">${new Date()}</div><p><strong>Build: dual-context-v9.13.4-browse-deep-research-skill-delete</strong></p><p>Enter "help" for available commands. OS agent: <strong>os</strong> toggles Agent mode · Dev: <strong>devmode</strong> · one-shot: <strong>os &lt;instruction&gt;</strong> · Research: <strong>research &lt;question&gt;</strong></p>`);
  }

  defineKeyEventListeners() {
    // Clicking empty terminal space should return focus to the command line,
    // but never collapse a text selection the user just made by dragging.
    this.terminalWindow.addEventListener('click', event => {
      const selection = window.getSelection?.();
      if (selection && !selection.isCollapsed && String(selection).length) return;
      if (event.target.closest('button, a, input, textarea, select, summary, [contenteditable="true"]')) return;
      this.cmdLine_.focus();
    }, false);
    this.cmdLine_.addEventListener('keydown', e => this.processNewCommand(e), false);
  }

  outputHelpMenu() {
    for (const category in this.helpMsgs) {
      this.output(`<span class="help-category">================ ${category} ================</span>`);
      for (const command in this.helpMsgs[category]) this.output(this.formatHelpMessage(command, this.helpMsgs[category][command]));
    }
  }

  runHelp(args) {
    if (!args.length) return this.outputHelpMenu();
    const name = args[0].toLowerCase();
    for (const category in this.helpMsgs) {
      if (this.helpMsgs[category][name]) return this.output(this.formatHelpMessage(name, this.helpMsgs[category][name]));
    }
    this.output(`Could not find help message for ${name}`);
  }

  output(data) {
    if (typeof data === 'object') data = JSON.stringify(data, null, 2);
    this.output_.insertAdjacentHTML('beforeend', `<p>${data ?? ''}</p>`);
    this.cmdLine_.focus();
    this.cmdLine_.scrollIntoView();
  }

  async clear() {
    // Clear the visible terminal immediately. The normal Tiny Web Agent chat
    // is intentionally untouched; only the focused Browser-OS model context
    // is cancelled/reset.
    this.output_.innerHTML = '';
    this.traceControls_ = null;
    this.osModeHistory_ = [];
    this.initTerminalMsg();
    try {
      await fetch('/api/os/reset', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ossession:this.osSessionId_}), cache:'no-store' });
    } catch (_) {
      // Clearing the local terminal should still succeed if the agent is offline.
    }
    return true;
  }

  async refreshTerminalAliases() {
    try {
      const response = await fetch('/api/terminal-shortcuts', {cache:'no-store'});
      const data = await response.json();
      this.terminalShortcuts_ = data.shortcuts && typeof data.shortcuts === 'object' ? data.shortcuts : {};
    } catch (_) {
      this.terminalShortcuts_ = this.terminalShortcuts_ || {};
    }
    return this.terminalShortcuts_;
  }

  async addTerminalAlias(args) {
    if (args.length < 2) return this.output('Usage: alias name[,name2] URL');
    const names = String(args[0] || '').split(',').map(x=>x.trim().toLowerCase()).filter(Boolean);
    const url = args.slice(1).join(' ').trim();
    try {
      const response = await fetch('/api/terminal-shortcuts', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body:JSON.stringify({names,url})
      });
      const data = await response.json().catch(()=>({}));
      if (!response.ok) return this.output(`alias: ${data.error || `HTTP ${response.status}`}`);
      this.terminalShortcuts_ = data.shortcuts || {};
      this.output(`Saved ${data.names.join(', ')} -> ${data.url}`);
      return true;
    } catch (error) {
      return this.output(`alias: ${error.message || error}`);
    }
  }

  async removeTerminalAlias(args) {
    if (!args.length) return this.output('Usage: unalias name[,name2]');
    const names = args.join(',').split(',').map(x=>x.trim().toLowerCase()).filter(Boolean);
    const encoded = encodeURIComponent(names.join(','));
    try {
      const response = await fetch(`/api/terminal-shortcuts/${encoded}`, {method:'DELETE'});
      const data = await response.json().catch(()=>({}));
      if (!response.ok) return this.output(`unalias: ${data.error || `HTTP ${response.status}`}`);
      this.terminalShortcuts_ = data.shortcuts || {};
      if (!data.removed?.length) this.output('No matching aliases found.');
      else this.output(`Removed: ${data.removed.join(', ')}`);
      return true;
    } catch (error) {
      return this.output(`unalias: ${error.message || error}`);
    }
  }

  async listTerminalAliases() {
    const items = await this.refreshTerminalAliases();
    const names = Object.keys(items).sort();
    if (!names.length) return this.output('No terminal aliases.');
    names.forEach(name=>this.output(`${name.padEnd(12, ' ')} ${items[name]}`));
    return items;
  }

  async runTerminalAlias(name) {
    if (!Object.hasOwn(this.terminalShortcuts_, name)) await this.refreshTerminalAliases();
    const url = this.terminalShortcuts_[name];
    if (!url) return false;
    window.open(url, '_blank', 'noopener');
    this.output(`Opening ${url}...`);
    return true;
  }

  whoami() {
    this.output(navigator.userAgent);
    this.output('Host: Browser-OS local dashboard');
    this.output(`Location: ${location.origin}`);
  }

  open(args) {
    const target = args.join(' ').trim();
    if (!target) return this.output('Usage: open shortcut-name | URL');
    if (ShortcutManager.open(target)) { this.output(`Opening ${target}...`); return true; }
    let url = target;
    if (!/^https?:\/\//i.test(url)) {
      if (/^[\w.-]+\.[a-z]{2,}(\/.*)?$/i.test(url)) url = `https://${url}`;
      else return this.output(`Shortcut not found: ${target}`);
    }
    window.open(url, '_blank', 'noopener');
    this.output(`Opening ${url}...`);
    return true;
  }

  search(args) {
    if (!args.length) return this.output('Usage: search query');
    const q = encodeURIComponent(args.join(' '));
    window.open(`https://www.google.com/search?q=${q}`, '_blank', 'noopener');
    return true;
  }

  shortcuts() {
    const items = ShortcutManager.load();
    if (!items.length) return this.output('No shortcuts.');
    items.forEach(item => this.output(`${item.name.padEnd(16, ' ')} ${item.url}`));
    return items;
  }

  async launchApp(args) {
    const query=args.join(' ').trim();
    // Plain `launch` opens the graphical launcher. Any argument means
    // "find the closest installed app and launch it directly".
    if(!query){ new LauncherWindow(); return true; }
    const result=await fetch('/api/apps/launch-match',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({query})
    }).then(async r=>{
      const data=await r.json().catch(()=>({}));
      if(!r.ok) throw new Error(data.error||'Launch failed');
      return data;
    });
    const matched=String(result.name||'');
    const correction=matched && matched.toLowerCase()!==query.toLowerCase()
      ? ` (matched "${this.escapeHtml(matched)}")` : '';
    this.output(`Launched ${this.escapeHtml(matched||query)}${correction}.`);
    return true;
  }

  async background(args) {
    const url = args.join(' ').trim();
    if (!url) {
      new BackgroundWindow();
      return true;
    }
    if (!/^https?:\/\//i.test(url)) return this.output('Usage: background [https://image-url]');
    const cfg = {...BackgroundManager.getConfig(), mode:'url', url};
    BackgroundManager.saveConfig(cfg);
    await BackgroundManager.apply(cfg);
    this.output('Background updated.');
    return true;
  }

  async processNewCommand(e) {
    const parsed = this.parseArguments(this.cmdLine_.value);
    const [cmd, ...args] = parsed;
    if (e.key === 'Tab') {
      e.preventDefault();
      this.autoCompleteCommand();
    } else if (e.key === 'Enter') {
      // Commit the submitted command before starting any asynchronous work.
      // Otherwise the live input still contains the command while an LLM/tool
      // request is pending and it appears to be repeated on the active line.
      const voiceLlmPending = this.cmdLine_.dataset.voiceLlmPending === '1';
      delete this.cmdLine_.dataset.voiceLlmPending;
      this.addCurrentLineToConsole();
      this.saveShellHistory();
      this.resetLine();
      await this.makeCommandReady(cmd, args, voiceLlmPending);
    } else {
      this.historyHandler(e);
    }
  }

  async makeCommandReady(cmd, args, voiceLlmPending=false) {
    try {
      if (!cmd) return this.output('');
      const name = cmd.toLowerCase();

      if(this.osMode_){
        if(name==='/exit')return this.devMode_?this.setDevMode(['off']):this.setOsMode(['off']);
        if(name==='/help'){this.output(this.devMode_?'Dev mode: project development tools are forced on. Use /exit or devmode off to return to the shell.':'Agent mode: type normally to chat/control Browser-OS. Use /exit or os off to return to the shell.');return true;}
        if(name==='os'||name==='agentmode'||name==='devmode'||name==='clear')return await this.commands[name](args,name);
        return await this.runOsCommand([cmd,...args],'agent',true);
      }
      // A voice-dictated terminal line is a one-shot OS-agent request.
      // Manual terminal input remains normal shell input.
      if (voiceLlmPending) return await this.runOsCommand([cmd,...args],'voice',true);
      if (Object.hasOwn(this.commands, name)) return await this.commands[name](args, name);
      if (await this.runTerminalAlias(name)) return true;
      return this.output(`${name}: command not found`);
    } catch (error) {
      this.output(`Error: ${error.message || error}`);
      return { error };
    }
  }

  resetLine() { this.cmdLine_.value = ''; this.cmdLine_.scrollIntoView(); }

  saveShellHistory() {
    if (this.cmdLine_.value) {
      if (this.history_[this.history_.length - 1] !== this.cmdLine_.value) this.history_.push(this.cmdLine_.value);
      this.histpos_ = this.history_.length;
    }
  }

  findMatchingPartialValues(partial, values) { return values.filter(v => v.startsWith(partial)); }

  autoCompleteCommand() {
    const raw = this.cmdLine_.value;
    if (raw.includes(' ')) return;
    const values = [...new Set([...Object.keys(this.commands), ...Object.keys(this.terminalShortcuts_ || {})])];
    const potential = this.findMatchingPartialValues(raw.toLowerCase(), values);
    if (potential.length === 1) this.cmdLine_.value = potential[0];
    else if (potential.length > 1) this.output(potential.join('   '));
  }

  addCurrentLineToConsole() {
    const line = this.cmdLine_.parentNode.parentNode.cloneNode(true);
    line.removeAttribute('id');
    line.classList.add('line');
    const input = line.querySelector(this.cmdLineId);
    input.autofocus = false;
    input.readOnly = true;
    this.output_.appendChild(line);
  }

  parseArguments(fullCommand) {
    const matches = String(fullCommand || '').match(/(?:[^\s"]+|"[^"]*")+/g) || [];
    return matches.map(v => v.replace(/^"|"$/g, ''));
  }

  historyHandler(e) {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    if (!this.history_.length) return;
    if (e.key === 'ArrowUp') this.histpos_ = Math.max(0, this.histpos_ - 1);
    else this.histpos_ = Math.min(this.history_.length, this.histpos_ + 1);
    this.cmdLine_.value = this.histpos_ === this.history_.length ? this.histtemp_ : this.history_[this.histpos_];
  }

  formatHelpMessage(commandName, message) {
    return `<span class="help-line"><b>${commandName}</b><span>${message}</span></span>`;
  }
}
window.Terminal = Terminal;
