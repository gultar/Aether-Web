(function(){
  const SETTINGS_KEY='browser-os-voice-settings-v1';
  const defaults={autoSubmit:false,shortcut:'Ctrl+Alt+V'};
  const editableSelector='input:not([type="button"]):not([type="submit"]):not([type="checkbox"]):not([type="radio"]), textarea, [contenteditable="true"]';
  const SEGMENT_MS=2600;
  const SILENCE_STOP_MS=5000;
  const VAD_INTERVAL_MS=100;
  let lastEditable=null, stream=null, recorder=null, recording=false, segmentTimer=null, sessionCounter=0;
  let audioContext=null, analyser=null, vadTimer=null;
  const queue=[];
  let queueRunning=false;

  function loadSettings(){try{return{...defaults,...(JSON.parse(localStorage.getItem(SETTINGS_KEY)||'null')||{})}}catch{return{...defaults}}}
  function saveSettings(v){localStorage.setItem(SETTINGS_KEY,JSON.stringify({...defaults,...v}))}
  function isEditable(el){return !!(el&&el.matches&&el.matches(editableSelector)&&!el.disabled&&!el.readOnly)}
  function rememberTarget(el){if(isEditable(el))lastEditable=el}
  document.addEventListener('focusin',e=>rememberTarget(e.target),true);
  document.addEventListener('pointerdown',e=>rememberTarget(e.target),true);
  function activeTarget(){const a=document.activeElement;return isEditable(a)?a:(isEditable(lastEditable)&&document.contains(lastEditable)?lastEditable:null)}

  function setButton(state){
    const b=document.querySelector('#voice-dictation-button');if(!b)return;
    b.classList.toggle('recording',state==='recording');b.classList.toggle('busy',false);
    b.setAttribute('aria-pressed',state==='recording'?'true':'false');
    const s=b.querySelector('span');if(s)s.textContent=state==='recording'?'■':'●';
    b.title=state==='recording'?'Stop voice dictation (Ctrl+Alt+V)':'Voice dictation (Ctrl+Alt+V)';
  }
  function notify(message,error=false){
    let n=document.querySelector('#voice-dictation-toast');
    if(!n){n=document.createElement('div');n.id='voice-dictation-toast';document.body.appendChild(n)}
    n.textContent=message;n.classList.toggle('error',!!error);n.classList.add('show');clearTimeout(n._timer);n._timer=setTimeout(()=>n.classList.remove('show'),2200);
  }
  function stopTracks(){if(stream)stream.getTracks().forEach(t=>{try{t.stop()}catch{}});stream=null}
  function stopVad(){
    clearInterval(vadTimer);vadTimer=null;analyser=null;
    if(audioContext){try{audioContext.close()}catch{}}audioContext=null;
  }

  function startVad(session){
    stopVad();
    const AudioCtx=window.AudioContext||window.webkitAudioContext;
    if(!AudioCtx||!stream)return;
    try{
      audioContext=new AudioCtx();
      const source=audioContext.createMediaStreamSource(stream);
      analyser=audioContext.createAnalyser();
      analyser.fftSize=1024;analyser.smoothingTimeConstant=0.15;
      source.connect(analyser);
      const samples=new Float32Array(analyser.fftSize);
      const calibration=[];
      const calibrationUntil=performance.now()+600;
      session.speechStarted=false;session.lastSpeechAt=0;
      vadTimer=setInterval(()=>{
        if(!recording||session.id!==sessionCounter||!analyser)return;
        analyser.getFloatTimeDomainData(samples);
        let sum=0;for(let i=0;i<samples.length;i++)sum+=samples[i]*samples[i];
        const rms=Math.sqrt(sum/samples.length);
        const now=performance.now();
        if(now<calibrationUntil){calibration.push(rms);return}
        const noise=calibration.length?calibration.reduce((a,b)=>a+b,0)/calibration.length:0;
        const threshold=Math.max(0.012,noise*3.0);
        if(rms>=threshold){session.speechStarted=true;session.lastSpeechAt=now;return}
        if(session.speechStarted&&session.lastSpeechAt&&now-session.lastSpeechAt>=SILENCE_STOP_MS){
          stop('silence');
        }
      },VAD_INTERVAL_MS);
    }catch(e){console.warn('[Voice] Silence detection unavailable:',e)}
  }

  function makeInsertion(target){
    target.focus({preventScroll:true});
    if(target.isContentEditable){
      const sel=window.getSelection();let range=null;
      if(sel&&sel.rangeCount&&target.contains(sel.anchorNode))range=sel.getRangeAt(0).cloneRange();
      if(!range){range=document.createRange();range.selectNodeContents(target);range.collapse(false)}
      range.deleteContents();
      const marker=document.createTextNode('');range.insertNode(marker);
      return {kind:'contenteditable',target,marker,hasText:false};
    }
    const value=String(target.value||'');
    const start=Number.isInteger(target.selectionStart)?target.selectionStart:value.length;
    const end=Number.isInteger(target.selectionEnd)?target.selectionEnd:start;
    if(typeof target.setRangeText==='function')target.setRangeText('',start,end,'end');
    else target.value=value.slice(0,start)+value.slice(end);
    return {kind:'input',target,pos:start,hasText:false};
  }

  function appendTranscript(insertion,text){
    const clean=String(text||'').trim();if(!clean||!insertion)return;
    const target=insertion.target;if(!document.contains(target))return;
    if(target.classList?.contains('cmdline')) target.dataset.voiceLlmPending='1';
    const addition=(insertion.hasText?' ':'')+clean;
    insertion.hasText=true;
    if(insertion.kind==='contenteditable'){
      const marker=insertion.marker;if(!marker?.isConnected)return;
      const node=document.createTextNode(addition);marker.parentNode.insertBefore(node,marker);
      const range=document.createRange();range.setStartAfter(marker);range.collapse(true);
      const sel=window.getSelection();sel.removeAllRanges();sel.addRange(range);
      target.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:addition}));
      return;
    }
    const pos=insertion.pos;target.focus({preventScroll:true});
    if(typeof target.setRangeText==='function')target.setRangeText(addition,pos,pos,'end');
    else{const v=String(target.value||'');target.value=v.slice(0,pos)+addition+v.slice(pos)}
    insertion.pos=pos+addition.length;
    try{target.setSelectionRange(insertion.pos,insertion.pos)}catch{}
    target.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:addition}));
  }

  function finalizeInsertion(insertion){
    if(insertion?.kind==='contenteditable'&&insertion.marker?.isConnected)insertion.marker.remove();
  }

  function autoSubmit(target){
    if(!target)return;
    if(target.classList?.contains('cmdline')){target.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true,cancelable:true}));return}
    const form=target.form||target.closest?.('form');if(form?.requestSubmit){form.requestSubmit();return}
    target.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true,cancelable:true}));
  }

  async function processQueue(){
    if(queueRunning)return;queueRunning=true;
    try{
      while(queue.length){
        const item=queue.shift();
        try{
          const res=await fetch('/api/voice/transcribe',{method:'POST',headers:{'Content-Type':item.mime||'application/octet-stream'},body:item.blob});
          const data=await res.json().catch(()=>({}));
          if(!res.ok)throw new Error(data.error||`Voice transcription failed (${res.status}).`);
          appendTranscript(item.session.insertion,data.text||'');
        }catch(e){console.error('[Voice]',e);notify(String(e.message||e),true)}
        finally{
          item.session.pending=Math.max(0,item.session.pending-1);
          maybeFinishSession(item.session);
        }
      }
    }finally{queueRunning=false}
  }

  function enqueueSegment(session,blob,mime){
    if(!blob?.size)return;
    session.pending++;
    queue.push({session,blob,mime});
    processQueue();
  }

  function maybeFinishSession(session){
    if(!session.stopped||session.pending>0||session.finished)return;
    session.finished=true;
    finalizeInsertion(session.insertion);
    if(loadSettings().autoSubmit)autoSubmit(session.target);
  }

  function startRecorderSegment(session){
    if(!recording||session.id!==sessionCounter||!stream)return;
    const preferred=['audio/webm;codecs=opus','audio/webm','audio/ogg;codecs=opus'];
    const mime=preferred.find(t=>MediaRecorder.isTypeSupported?.(t))||'';
    const localChunks=[];
    const r=mime?new MediaRecorder(stream,{mimeType:mime}):new MediaRecorder(stream);
    recorder=r;
    r.addEventListener('dataavailable',e=>{if(e.data?.size)localChunks.push(e.data)});
    r.addEventListener('stop',()=>{
      const blob=new Blob(localChunks,{type:r.mimeType||mime||'audio/webm'});
      enqueueSegment(session,blob,r.mimeType||mime||'audio/webm');
      if(recording&&session.id===sessionCounter)startRecorderSegment(session);
      else maybeFinishSession(session);
    },{once:true});
    r.start();
    segmentTimer=setTimeout(()=>{segmentTimer=null;if(r.state==='recording'){try{r.stop()}catch{}}},SEGMENT_MS);
  }

  async function start(){
    if(recording)return;
    const target=activeTarget();
    if(!target){notify('Place the cursor in a text field first.',true);return}
    const id=++sessionCounter;
    const session={id,target,insertion:makeInsertion(target),pending:0,stopped:false,finished:false};
    try{
      stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true},video:false});
      if(id!==sessionCounter){stopTracks();finalizeInsertion(session.insertion);return}
      recording=true;window.__browserOSVoiceSession=session;
      setButton('recording');notify('Listening…');
      startVad(session);
      startRecorderSegment(session);
    }catch(e){
      console.error('[Voice]',e);session.stopped=true;finalizeInsertion(session.insertion);stopVad();stopTracks();recording=false;recorder=null;setButton('idle');notify(String(e.message||e),true);
    }
  }

  function stop(reason='manual'){
    if(!recording)return;
    recording=false;
    const session=window.__browserOSVoiceSession;
    if(session)session.stopped=true;
    clearTimeout(segmentTimer);segmentTimer=null;
    const r=recorder;recorder=null;
    if(r?.state==='recording'){try{r.stop()}catch{}}
    stopVad();
    stopTracks();
    setButton('idle');notify(reason==='silence'?'Voice stopped after 5 seconds of silence.':'Voice recording stopped.');
    if(session)maybeFinishSession(session);
  }

  function toggle(){recording?stop():start()}

  function init(){
    const b=document.querySelector('#voice-dictation-button');
    if(b){b.addEventListener('pointerdown',e=>e.preventDefault());b.addEventListener('click',toggle)}
    window.addEventListener('keydown',e=>{if(e.ctrlKey&&e.altKey&&!e.shiftKey&&e.key.toLowerCase()==='v'){e.preventDefault();e.stopPropagation();toggle()}},true);
    setButton('idle');
  }

  class VoiceSettingsWindow{
    constructor(opts={}){
      const cfg=loadSettings(),node=document.createElement('section');node.className='tool voice-settings-tool';
      node.innerHTML=`<header class="tool-head"><span>Voice input</span><small>Local Faster-Whisper</small></header><div class="voice-settings-body"><label class="voice-setting-row"><span><b>Keyboard shortcut</b><small>Start dictation; it stops automatically after 5 seconds of silence. Press again to stop immediately.</small></span><kbd>Ctrl + Alt + V</kbd></label><label class="voice-setting-row"><span><b>Submit automatically</b><small>Leave off to review recognized text before submitting. In the terminal, dictated text is sent to the OS agent on its next submission.</small></span><input class="voice-auto-submit" type="checkbox"></label><div class="voice-model-status">Model: configured via BROWSER_OS_WHISPER_MODEL or models\\faster-whisper-small.en</div></div>`;
      document.querySelector('#window-mounts').appendChild(node);const cb=node.querySelector('.voice-auto-submit');cb.checked=!!cfg.autoSubmit;cb.onchange=()=>saveSettings({...loadSettings(),autoSubmit:cb.checked});
      this.window=new ApplicationWindow({title:'Voice Input',label:`voice-settings-${Date.now()}`,x:opts.x,y:opts.y,width:opts.width||'470',height:opts.height||'330',launcher:{name:'VoiceSettingsWindow',opts:{...opts}},mount:node,onclose:()=>node.remove()});
    }
  }

  window.BrowserOSVoice={toggle,start,stop,loadSettings,saveSettings};window.VoiceSettingsWindow=VoiceSettingsWindow;
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
})();
