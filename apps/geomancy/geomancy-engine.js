(function(global){
  "use strict";

  const FIGURES = {
    "0000": {name:"Populus", latin:"Populus", gloss:"The People"},
    "1111": {name:"Via", latin:"Via", gloss:"The Way"},
    "0011": {name:"Fortuna Major", latin:"Fortuna Major", gloss:"Greater Fortune"},
    "1100": {name:"Fortuna Minor", latin:"Fortuna Minor", gloss:"Lesser Fortune"},
    "0101": {name:"Acquisitio", latin:"Acquisitio", gloss:"Gain"},
    "1010": {name:"Amissio", latin:"Amissio", gloss:"Loss"},
    "1000": {name:"Laetitia", latin:"Laetitia", gloss:"Joy"},
    "0001": {name:"Tristitia", latin:"Tristitia", gloss:"Sorrow"},
    "1101": {name:"Puer", latin:"Puer", gloss:"The Boy"},
    "1011": {name:"Puella", latin:"Puella", gloss:"The Girl"},
    "0100": {name:"Rubeus", latin:"Rubeus", gloss:"Red"},
    "0010": {name:"Albus", latin:"Albus", gloss:"White"},
    "0110": {name:"Conjunctio", latin:"Conjunctio", gloss:"Conjunction"},
    "1001": {name:"Carcer", latin:"Carcer", gloss:"Prison"},
    "0111": {name:"Caput Draconis", latin:"Caput Draconis", gloss:"Dragon's Head"},
    "1110": {name:"Cauda Draconis", latin:"Cauda Draconis", gloss:"Dragon's Tail"}
  };

  const HOUSE_NAMES = [
    "Vita","Lucrum","Fratres","Genitor","Nati","Valetudo",
    "Uxor","Mors","Itineris","Regnum","Benefacta","Carcer"
  ];
  const ROMAN = ["I","II","III","IV","V","VI","VII","VIII","IX","X","XI","XII"];
  const ELEMENTS = ["Fire","Air","Water","Earth"];

  function xmur3(str) {
    let h = 1779033703 ^ str.length;
    for (let i=0;i<str.length;i++) {
      h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
      h = h << 13 | h >>> 19;
    }
    return function() {
      h = Math.imul(h ^ (h >>> 16), 2246822507);
      h = Math.imul(h ^ (h >>> 13), 3266489909);
      return (h ^= h >>> 16) >>> 0;
    };
  }

  function sfc32(a,b,c,d) {
    return function() {
      a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
      let t = (a + b) | 0;
      a = b ^ b >>> 9;
      b = c + (c << 3) | 0;
      c = (c << 21 | c >>> 11);
      d = d + 1 | 0;
      t = t + d | 0;
      c = c + t | 0;
      return (t >>> 0) / 4294967296;
    };
  }

  function rngFromSeed(seed) {
    const f = xmur3(seed);
    return sfc32(f(), f(), f(), f());
  }

  function randomNonce() {
    if (global.crypto && crypto.getRandomValues) {
      const u = new Uint32Array(4); crypto.getRandomValues(u);
      return Array.from(u).map(v=>v.toString(16).padStart(8,"0")).join("");
    }
    return (Date.now().toString(16) + Math.random().toString(16).slice(2)).padEnd(32,"0").slice(0,32);
  }

  function xor(a,b) {
    return a.map((v,i)=>v ^ b[i]);
  }

  function figure(bits) {
    const key = bits.join("");
    const meta = FIGURES[key] || {name:key, latin:key, gloss:""};
    return {bits:[...bits], key, ...meta, points: bits.reduce((s,b)=>s+(b?1:2),0)};
  }

  function castMother(rng) {
    return figure([0,1,2,3].map(()=>rng()<0.5?0:1));
  }

  function daughter(mothers,row) {
    return figure(mothers.map(m=>m.bits[row]));
  }

  function addFig(a,b) {
    return figure(xor(a.bits,b.bits));
  }

  function modHouse(n) {
    const r = n % 12;
    return r === 0 ? 12 : r;
  }

  function triplicities(houses) {
    return [
      [houses[0], houses[1], houses[8]],
      [houses[2], houses[3], houses[9]],
      [houses[4], houses[5], houses[10]],
      [houses[6], houses[7], houses[11]]
    ];
  }

  // Trace an active Judge point through the XOR genealogy.
  // For passive Judge lines, return a compact state rather than inventing a single root.
  function viaPuncti(row, chart) {
    const judgeBit = chart.judge.bits[row];
    if (judgeBit === 0) {
      const parents = [chart.rightWitness.bits[row], chart.leftWitness.bits[row]];
      if (parents[0]===1 && parents[1]===1) {
        return {element:ELEMENTS[row], status:"cannot-be-formed", roots:[], label:"Cannot Be Formed"};
      }
      return {element:ELEMENTS[row], status:"passive", roots:[], label:"Passive / branching"};
    }

    let node;
    if (chart.rightWitness.bits[row] === 1 && chart.leftWitness.bits[row] === 0) node = {type:"witness", idx:0};
    else if (chart.leftWitness.bits[row] === 1 && chart.rightWitness.bits[row] === 0) node = {type:"witness", idx:1};
    else return {element:ELEMENTS[row], status:"ambiguous", roots:[], label:"Ambiguous"};

    const witnesses = [chart.rightWitness, chart.leftWitness];
    const witnessParents = [[chart.nieces[0],chart.nieces[1]],[chart.nieces[2],chart.nieces[3]]];
    const wp = witnessParents[node.idx];
    let nieceIndex;
    if (wp[0].bits[row]===1 && wp[1].bits[row]===0) nieceIndex = node.idx*2;
    else if (wp[1].bits[row]===1 && wp[0].bits[row]===0) nieceIndex = node.idx*2+1;
    else return {element:ELEMENTS[row], status:"stopped", roots:[], label:`Stops at ${witnesses[node.idx].name}`};

    const topParents = [
      [chart.mothers[0],chart.mothers[1]],
      [chart.mothers[2],chart.mothers[3]],
      [chart.daughters[0],chart.daughters[1]],
      [chart.daughters[2],chart.daughters[3]]
    ][nieceIndex];

    let root = null, rootIndex = null, rootKind = nieceIndex < 2 ? "Mother" : "Daughter";
    if (topParents[0].bits[row]===1 && topParents[1].bits[row]===0) { root=topParents[0]; rootIndex=(nieceIndex%2)*2; }
    else if (topParents[1].bits[row]===1 && topParents[0].bits[row]===0) { root=topParents[1]; rootIndex=(nieceIndex%2)*2+1; }
    if (!root) return {element:ELEMENTS[row], status:"stopped", roots:[], label:`Stops at ${chart.nieces[nieceIndex].name}`};

    if (nieceIndex >= 2) rootIndex += 0;
    const absoluteIndex = nieceIndex < 2 ? rootIndex : rootIndex;
    const ordinal = ["First","Second","Third","Fourth"][absoluteIndex];
    return {
      element:ELEMENTS[row], status:"active", roots:[root.name],
      label:`${ordinal} ${rootKind} — ${root.name}`
    };
  }

  function adjacentHouses(house) {
    const h = Number(house);
    return [h === 1 ? 12 : h - 1, h === 12 ? 1 : h + 1];
  }

  function occurrences(houses, key, exclude=[]) {
    const banned = new Set(exclude.map(Number));
    const out = [];
    houses.forEach((f,i)=>{
      const house = i + 1;
      if (f.key === key && !banned.has(house)) out.push(house);
    });
    return out;
  }

  function isAdjacent(a,b) {
    return adjacentHouses(a).includes(Number(b));
  }

  function analyzePerfection(chart, querentHouse=1, quesitedHouse=7) {
    const qh = Number(querentHouse), sh = Number(quesitedHouse);
    if (!Number.isInteger(qh) || !Number.isInteger(sh) || qh < 1 || qh > 12 || sh < 1 || sh > 12 || qh === sh) {
      return {
        valid:false, perfects:false, denial:false,
        querent_house:qh, quesited_house:sh,
        modes:[], summary:"Choose two different houses from I to XII."
      };
    }

    const qf = chart.houses[qh-1];
    const sf = chart.houses[sh-1];
    const modes = [];

    // 1) Occupation: both significator houses contain the same figure.
    if (qf.key === sf.key) {
      modes.push({
        type:"Occupation",
        figure:qf.name,
        houses:[qh,sh],
        label:`Occupation — House ${ROMAN[qh-1]} and House ${ROMAN[sh-1]} contain ${qf.name}`,
        detail:"The querent and quesited significators are the same figure."
      });
    }

    // 2) Conjunction: either significator repeats in a house immediately beside the other significator.
    const qMoves = occurrences(chart.houses, qf.key, [qh]).filter(h=>isAdjacent(h,sh));
    const sMoves = occurrences(chart.houses, sf.key, [sh]).filter(h=>isAdjacent(h,qh));
    qMoves.forEach(h=>modes.push({
      type:"Conjunction", figure:qf.name, houses:[qh,h,sh], mover:"querent",
      label:`Conjunction — Querent figure ${qf.name} moves to House ${ROMAN[h-1]}, beside House ${ROMAN[sh-1]}`,
      detail:"The querent significator passes to a house adjacent to the quesited."
    }));
    sMoves.forEach(h=>modes.push({
      type:"Conjunction", figure:sf.name, houses:[sh,h,qh], mover:"quesited",
      label:`Conjunction — Quesited figure ${sf.name} moves to House ${ROMAN[h-1]}, beside House ${ROMAN[qh-1]}`,
      detail:"The quesited significator passes to a house adjacent to the querent."
    }));

    // 3) Mutation: the two significators repeat elsewhere and those new positions are adjacent.
    if (qf.key !== sf.key) {
      const qElse = occurrences(chart.houses, qf.key, [qh]);
      const sElse = occurrences(chart.houses, sf.key, [sh]);
      qElse.forEach(a=>sElse.forEach(b=>{
        if (a !== b && isAdjacent(a,b)) {
          modes.push({
            type:"Mutation", figures:[qf.name,sf.name], houses:[a,b],
            label:`Mutation — ${qf.name} in House ${ROMAN[a-1]} meets ${sf.name} in House ${ROMAN[b-1]}`,
            detail:"The two significators repeat elsewhere in adjacent houses."
          });
        }
      }));
    }

    // 4) Translation: a third figure repeats beside both significator houses, forming a bridge.
    const qNeighbors = adjacentHouses(qh);
    const sNeighbors = adjacentHouses(sh);
    const seenTranslations = new Set();
    Object.keys(FIGURES).forEach(key=>{
      if (key === qf.key || key === sf.key) return;
      const occ = occurrences(chart.houses,key);
      const nearQ = occ.filter(h=>qNeighbors.includes(h));
      const nearS = occ.filter(h=>sNeighbors.includes(h));
      nearQ.forEach(a=>nearS.forEach(b=>{
        if (a === b) return; // classical translation uses the same third figure in two positions
        const pair = [Math.min(a,b),Math.max(a,b)];
        const sig = `${key}:${pair.join('-')}`;
        if (seenTranslations.has(sig)) return;
        seenTranslations.add(sig);
        modes.push({
          type:"Translation", figure:FIGURES[key].name, houses:[a,b],
          label:`Translation — ${FIGURES[key].name} bridges House ${ROMAN[qh-1]} and House ${ROMAN[sh-1]} through Houses ${ROMAN[a-1]} and ${ROMAN[b-1]}`,
          detail:"A third figure appears beside both significators, linking them."
        });
      }));
    });

    // Deduplicate identical labels while preserving strongest-mode order.
    const unique = [];
    const labels = new Set();
    for (const mode of modes) {
      if (!labels.has(mode.label)) { labels.add(mode.label); unique.push(mode); }
    }
    const perfects = unique.length > 0;
    return {
      valid:true,
      perfects,
      denial:!perfects,
      querent_house:qh,
      querent_roman:ROMAN[qh-1],
      querent_figure:qf.name,
      quesited_house:sh,
      quesited_roman:ROMAN[sh-1],
      quesited_figure:sf.name,
      modes:unique,
      summary: perfects
        ? `${unique.length === 1 ? unique[0].type : "Multiple modes"} — chart perfects between Houses ${ROMAN[qh-1]} and ${ROMAN[sh-1]}`
        : `Denial — no classical mode of perfection connects Houses ${ROMAN[qh-1]} and ${ROMAN[sh-1]}`
    };
  }

  function buildInterpretationPayload(chart, perfection=chart.perfection || analyzePerfection(chart,1,7)) {
    return {
      instruction:
        "Interpret this geomantic chart as a symbolic divination reading. Use the query as context. Explain the Judge first, then Witnesses and Sentence/Reconciler, then explicitly assess the supplied perfection result for the selected querent and quesited significators. Continue with relevant houses, triplicities, Via Puncti, Part of Fortune, Part of Spirit, and chart sum. Distinguish observation from interpretation; do not present the reading as certain fact.",
      query: chart.query,
      seed: chart.seed,
      cast_id: chart.nonce,
      mothers: chart.mothers.map(f=>({name:f.name,bits:f.key})),
      daughters: chart.daughters.map(f=>({name:f.name,bits:f.key})),
      nieces: chart.nieces.map(f=>({name:f.name,bits:f.key})),
      court: {
        right_witness: chart.rightWitness.name,
        left_witness: chart.leftWitness.name,
        judge: chart.judge.name,
        sentence: chart.sentence.name
      },
      houses: chart.houses.map((f,i)=>({
        house:i+1, roman:ROMAN[i], traditional_name:HOUSE_NAMES[i], figure:f.name, bits:f.key
      })),
      triplicities: chart.triplicities.map((t,i)=>({number:i+1, figures:t.map(f=>f.name)})),
      via_puncti: chart.viaPuncti,
      perfection,
      lots: {part_of_fortune:chart.partOfFortune, part_of_spirit:chart.partOfSpirit},
      chart_sum: chart.sum,
      benchmark_sum: 96
    };
  }

  function cast(query, options={}) {
    const nonce = options.nonce || randomNonce();
    const seed = options.seed || `${query || ""}\u241F${nonce}`;
    const rng = rngFromSeed(seed);

    const mothers = [0,1,2,3].map(()=>castMother(rng));
    const daughters = [0,1,2,3].map(i=>daughter(mothers,i));
    const nieces = [
      addFig(mothers[0],mothers[1]),
      addFig(mothers[2],mothers[3]),
      addFig(daughters[0],daughters[1]),
      addFig(daughters[2],daughters[3])
    ];
    const rightWitness = addFig(nieces[0],nieces[1]);
    const leftWitness  = addFig(nieces[2],nieces[3]);
    const judge = addFig(rightWitness,leftWitness);
    const sentence = addFig(judge,mothers[0]);

    const houses = [...mothers,...daughters,...nieces];
    const all16 = [...houses,rightWitness,leftWitness,judge,sentence];

    const partOfFortune = modHouse(houses.reduce((s,f)=>s+f.points,0));
    const partOfSpirit = modHouse(houses.reduce((s,f)=>s+f.bits.reduce((a,b)=>a+b,0),0));
    const sum = all16.reduce((s,f)=>s+f.points,0);

    const chart = {
      query: query || "",
      nonce, seed,
      mothers,daughters,nieces,rightWitness,leftWitness,judge,sentence,
      houses,
      triplicities: triplicities(houses),
      partOfFortune,partOfSpirit,sum
    };
    chart.viaPuncti = [0,1,2,3].map(row=>viaPuncti(row,chart));
    chart.perfection = analyzePerfection(chart,1,7);
    chart.payload = buildInterpretationPayload(chart, chart.perfection);
    return chart;
  }

  global.GeomancyEngine = {cast, figure, FIGURES, HOUSE_NAMES, ROMAN, ELEMENTS, analyzePerfection, buildInterpretationPayload};
})(window);
