(function(){
  "use strict";

  function buildInterpretationPrompt(payload){
    return `Interpret this geomantic chart as a symbolic divination reading.

QUESTION
${payload.query || "(No question supplied)"}

CHART DATA
${JSON.stringify(payload, null, 2)}

Reading method:
- Treat the supplied chart as authoritative; do not regenerate or alter any figure.
- Explain the Judge first.
- Then explain the Right Witness, Left Witness, and Sentence/Reconciler.
- Assess the supplied Perfection result for the selected Querent and Quesited significator houses. Explain each detected mode (Occupation, Conjunction, Mutation, Translation), or Denial if none applies.
- Discuss the houses most relevant to the question and their figures.
- Discuss the four Triplicities/Triads and any strong repetition or testimony.
- Discuss Via Puncti, Part of Fortune, Part of Spirit/Index, and the chart sum when useful.
- Synthesize the chart into a direct answer to the querent's question.
- Treat geomancy as symbolic divination and tendencies, not certain factual prediction.`;
  }

  class GeomancyWindow {
    constructor(opts={}){
      const host=document.createElement('section');
      host.className='geomancy-host';
      const frame=document.createElement('iframe');
      frame.className='geomancy-frame';
      frame.src='./apps/geomancy/index.html';
      frame.title='Geomancy — Shield & House Chart';
      frame.allow='clipboard-read; clipboard-write';
      host.appendChild(frame);
      document.querySelector('#window-mounts').appendChild(host);

      const width=opts.width||Math.max(820,Math.min(window.innerWidth-70,1480));
      const height=opts.height||Math.max(620,Math.min(window.innerHeight-80,940));
      this.window=new ApplicationWindow({
        title:'Geomancy — Shield & House Chart',
        label:opts.label||'Geomancy',
        x:opts.x===undefined?'center':opts.x,
        y:opts.y===undefined?'center':opts.y,
        width,height,
        launcher:{name:'GeomancyWindow',opts:{...opts,width,height}},
        mount:host,
        onclose:()=>host.remove()
      });
      this.frame=frame;
    }
  }

  function openInterpretation(payload){
    if(!payload || typeof payload!=='object') return;
    if(typeof TinyAgentWindow!=='function'){
      alert('Tiny Web Agent is unavailable in this BrowserOS build.');
      return;
    }
    new TinyAgentWindow({
      newConversation:true,
      initialMessage:buildInterpretationPrompt(payload),
      skill:'geomancy-reader',
      label:'Geomancy interpretation'
    });
  }

  window.addEventListener('message',event=>{
    if(event?.data?.type==='browseros-geomancy-interpret' && event.data.payload){
      openInterpretation(event.data.payload);
    }
  });

  window.GeomancyWindow=GeomancyWindow;
  window.openGeomancyInterpretation=openInterpretation;
})();
