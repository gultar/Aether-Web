(() => {
  const $ = s => document.querySelector(s);
  const esc = s => String(s??"").replace(/[&<>\"]/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'\"':"&quot;"}[m]));
  let current = null;
  let querentHouse = 1;
  let quesitedHouse = 7;

  function dots(bits){
    return `<div class="dots">${bits.map(b=>`<div class="dotrow">${b?'<i class="dot"></i>':'<i class="dot"></i><i class="dot"></i>'}</div>`).join("")}</div>`;
  }
  function fig(f,slot=""){
    return `<div class="figure"><div class="slot">${esc(slot)}</div>${dots(f.bits)}<div class="name" title="${esc(f.name)}">${esc(f.name)}</div></div>`;
  }
  function renderShield(c){
    const top=[...c.daughters.map((f,i)=>fig(f,`D${i+1}`)),...c.mothers.slice().reverse().map((f,i)=>fig(f,`M${4-i}`))];
    $("#shield").innerHTML=`<div class="rank r8">${top.join("")}</div><div class="rank r4">${c.nieces.map((f,i)=>fig(f,`N${i+1}`)).join("")}</div><div class="rank r2">${fig(c.rightWitness,"Right Witness")}${fig(c.leftWitness,"Left Witness")}</div><div class="rank r1">${fig(c.judge,"Judge")}</div>`;
  }
  function houseClass(c,n){
    return n===c.partOfFortune&&n===c.partOfSpirit?"mark-both":n===c.partOfFortune?"mark-fortune":n===c.partOfSpirit?"mark-spirit":"";
  }
  function sigClass(n){
    return n===querentHouse&&n===quesitedHouse?"selected-both":n===querentHouse?"selected-querent":n===quesitedHouse?"selected-quesited":"";
  }
  function renderHouseSquare(c){
    const positions={1:[1,4],2:[2,4],3:[3,4],4:[4,4],5:[4,3],6:[4,2],7:[4,1],8:[3,1],9:[2,1],10:[1,1],11:[1,2],12:[1,3]};
    const p=c.perfection;
    const center=`<div class="square-center"><div class="center-title">${p?.perfects?'Perfection':'Denial'}</div><div class="center-sub">${esc(p?.summary||'Select significator houses to assess perfection.')}</div><div class="center-grid"><div class="center-cell"><small>Judge</small><strong>${esc(c.judge.name)}</strong></div><div class="center-cell"><small>Sentence</small><strong>${esc(c.sentence.name)}</strong></div><div class="center-cell"><small>Fortune</small><strong>House ${c.partOfFortune}</strong></div><div class="center-cell"><small>Spirit</small><strong>House ${c.partOfSpirit}</strong></div></div></div>`;
    const houses=c.houses.map((f,i)=>{
      const n=i+1,pos=positions[n],cls=[houseClass(c,n),sigClass(n)].filter(Boolean).join(' ');
      const lotTags=[n===c.partOfFortune?'<span class="lot-tag">Fortune</span>':'',n===c.partOfSpirit?'<span class="lot-tag">Spirit</span>':''].filter(Boolean).join('');
      const sigTags=[n===querentHouse?'<span class="sig-tag q">Querent</span>':'',n===quesitedHouse?'<span class="sig-tag s">Quesited</span>':''].filter(Boolean).join('');
      return `<div class="square-house ${cls}" style="grid-row:${pos[0]};grid-column:${pos[1]}"><div class="house-badge">${n}</div>${sigTags?`<div class="sig-tags">${sigTags}</div>`:''}<div class="house-roman">${GeomancyEngine.ROMAN[i]}</div><div class="house-name">${GeomancyEngine.HOUSE_NAMES[i]}</div>${dots(f.bits)}<div class="figure-name">${esc(f.name)}</div>${lotTags?`<div class="lot-tags">${lotTags}</div>`:''}</div>`;
    }).join('');
    $("#houseSquare").innerHTML=center+houses;
  }
  function renderHouses(c){
    $("#houses").innerHTML=c.houses.map((f,i)=>{const n=i+1;return `<div class="house ${houseClass(c,n)}"><div class="hnum">${GeomancyEngine.ROMAN[i]}</div><div><div class="hlabel">House ${n} · ${GeomancyEngine.HOUSE_NAMES[i]}</div><div class="hfig">${esc(f.name)}</div></div></div>`}).join("");
  }
  function houseOptions(selected){
    return GeomancyEngine.ROMAN.map((r,i)=>`<option value="${i+1}" ${i+1===selected?'selected':''}>${r} — House ${i+1} · ${GeomancyEngine.HOUSE_NAMES[i]}</option>`).join('');
  }
  function renderPerfection(c){
    const p=c.perfection;
    $("#perfectionBadge").textContent=p.valid?(p.perfects?'Perfects':'Denial'):'Select';
    $("#perfectionBadge").className=`perfection-badge ${p.valid?(p.perfects?'yes':'no'):''}`;
    $("#perfectionSummary").textContent=p.summary;
    $("#perfectionSummary").className=`perfection-summary ${p.valid?(p.perfects?'yes':'no'):''}`;
    if(!p.valid){$("#perfectionModes").innerHTML='';return;}
    if(!p.modes.length){
      $("#perfectionModes").innerHTML='<div class="perfection-mode perfection-denial"><div class="mode-name">Denial</div><div class="mode-label">No Occupation, Conjunction, Mutation or Translation connects the selected significators.</div></div>';
      return;
    }
    $("#perfectionModes").innerHTML=p.modes.map(m=>`<div class="perfection-mode"><div class="mode-name">${esc(m.type)}</div><div class="mode-label">${esc(m.label)}</div><div class="mode-detail">${esc(m.detail||'')}</div></div>`).join('');
  }
  function updatePerfection(){
    if(!current)return;
    querentHouse=Number($("#querentHouse").value)||1;
    quesitedHouse=Number($("#quesitedHouse").value)||7;
    current.perfection=GeomancyEngine.analyzePerfection(current,querentHouse,quesitedHouse);
    current.payload=GeomancyEngine.buildInterpretationPayload(current,current.perfection);
    $("#payload").textContent=JSON.stringify(current.payload,null,2);
    renderPerfection(current);renderHouseSquare(current);
  }
  function render(c){
    current=c;
    c.perfection=GeomancyEngine.analyzePerfection(c,querentHouse,quesitedHouse);
    c.payload=GeomancyEngine.buildInterpretationPayload(c,c.perfection);
    $("#castid").textContent=c.nonce.slice(0,16);$("#sum").textContent=c.sum;$("#fortune").textContent=c.partOfFortune;$("#spirit").textContent=c.partOfSpirit;$("#judgeName").textContent=c.judge.name;
    $("#court").innerHTML=[["Right Witness",c.rightWitness],["Left Witness",c.leftWitness],["Judge",c.judge],["Sentence",c.sentence]].map(([s,f])=>fig(f,s)).join("");
    $("#triplicities").innerHTML=c.triplicities.map((t,i)=>`<div class="item"><span>${i+1}${["st","nd","rd","th"][i]} Triad</span><strong>${t.map(f=>esc(f.name)).join(" → ")}</strong></div>`).join("");
    $("#via").innerHTML=c.viaPuncti.map(v=>`<div class="item"><span>${esc(v.element)}</span><strong>${esc(v.label)}</strong></div>`).join("");
    $("#payload").textContent=JSON.stringify(c.payload,null,2);
    renderShield(c);renderHouseSquare(c);renderHouses(c);renderPerfection(c);
  }
  function cast(){render(GeomancyEngine.cast($("#query").value.trim()));}
  async function interpret(){
    if(!current)cast();
    updatePerfection();
    const detail=current.payload;
    window.dispatchEvent(new CustomEvent("browseros-geomancy-interpret",{detail}));
    try{window.parent?.postMessage?.({type:"browseros-geomancy-interpret",payload:detail},"*");}catch(_){}
    $("#interpret").textContent="Sent to AI";setTimeout(()=>$("#interpret").textContent="Interpret with AI",1400);
  }
  $("#querentHouse").innerHTML=houseOptions(querentHouse);
  $("#quesitedHouse").innerHTML=houseOptions(quesitedHouse);
  $("#querentHouse").addEventListener("change",updatePerfection);
  $("#quesitedHouse").addEventListener("change",updatePerfection);
  $("#cast").addEventListener("click",cast);$("#interpret").addEventListener("click",interpret);
  $("#copy").addEventListener("click",async()=>{if(!current)return;updatePerfection();await navigator.clipboard.writeText(JSON.stringify(current.payload,null,2));});
  $("#query").addEventListener("keydown",e=>{if(e.key==="Enter")cast();});
  $("#query").value="What should I understand about this situation?";cast();
})();
