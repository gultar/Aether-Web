(function(){
function optsUrl(base,opts={}){try{const u=new URL(base);if(opts.conversationId)u.searchParams.set('conversation',opts.conversationId);if(opts.newConversation)u.searchParams.set('new','1');if(opts.initialMessage)u.searchParams.set('message',opts.initialMessage);if(opts.skill)u.searchParams.set('skill',opts.skill);return u.toString()}catch{return base}}

// Programmatic hand-off values are one-shot launch instructions. Never put them
// in BrowserOS' persisted window launcher state, otherwise a crash/restart can
// reconstruct the window and submit the same prompt again.
function persistentLauncherOpts(opts={}){
  const safe={...opts};
  delete safe.initialMessage;
  delete safe.newConversation;
  delete safe.skill;
  return safe;
}

class TinyAgentWindow{
  constructor(opts={}){
    this.opts=opts;
    const host=document.createElement('section');
    host.className='tiny-agent-shell';
    host.innerHTML=`<div class="tiny-agent-loading"><strong>Tiny Web Agent</strong><span>Starting local agent service…</span><small>The GGUF model is not loaded until the agent needs it.</small></div>`;
    document.querySelector('#window-mounts').appendChild(host);
    const width=opts.width||Math.min(1180,Math.max(760,window.innerWidth-130));
    const height=opts.height||Math.min(780,Math.max(560,window.innerHeight-110));
    this.window=new ApplicationWindow({
      title:'Tiny Web Agent',label:`tiny-agent-${Date.now()}`,x:opts.x,y:opts.y,width:String(width),height:String(height),
      launcher:{name:'TinyAgentWindow',opts:persistentLauncherOpts(opts)},mount:host,onclose:()=>host.remove()
    });
    this.mount(host);
  }
  async mount(host){
    try{
      let r=await fetch('/api/agent/start',{method:'POST'}); let d=await r.json();
      if(!r.ok) throw new Error(d.error||'Unable to start Tiny Web Agent.');
      const iframe=document.createElement('iframe');
      iframe.className='tiny-agent-frame';
      const base=d.url||'http://127.0.0.1:7860/';
      iframe.src=optsUrl(base,this.opts||{});
      iframe.title='Tiny Web Agent'; iframe.allow='clipboard-read; clipboard-write';
      host.replaceChildren(iframe);
    }catch(error){
      host.innerHTML=`<div class="tiny-agent-loading tiny-agent-error"><strong>Tiny Web Agent could not start</strong><span>${this.escape(error.message)}</span><small>Run <code>setup-agent.bat</code>. It now detects <code>python.exe</code>, verifies the environment, and saves that exact interpreter for BrowserOS. The <code>py</code> launcher is not required.</small><button type="button">Retry</button></div>`;
      host.querySelector('button').onclick=()=>{host.innerHTML='<div class="tiny-agent-loading"><strong>Tiny Web Agent</strong><span>Retrying…</span></div>';this.mount(host)};
    }
  }
  escape(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]))}
}
window.TinyAgentWindow=TinyAgentWindow;
})();
