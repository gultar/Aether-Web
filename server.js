const express = require('express');
const { createServer } = require('http');
const { execFile, spawn, spawnSync } = require('child_process');
const util = require('util');
const si = require('systeminformation');
const Parser = require('rss-parser');
const path = require('path');
const fs = require('fs');
const net = require('net');
const os = require('os');
const crypto = require('crypto');
const { CronScheduler } = require('./private/cron/cron_scheduler');
const { parseIcsCalendar, filterEvents } = require('./private/calendar/outlook_ics');

const execFileAsync = util.promisify(execFile);
const app = express();
const server = createServer(app);
const parser = new Parser({ timeout: 8000 });
const port = Number(process.env.PORT || 8001);
const root = __dirname;
const BUILD_ID = 'dual-context-v9.13.1-ars-technica-rss';
const readJson = (file, fallback=[]) => { try { return JSON.parse(fs.readFileSync(path.join(root,file),'utf8')); } catch { return fallback; } };
app.use(express.json());
app.get('/api/version', (_req,res)=>res.json({build:BUILD_ID, osCommand:true, port}));

// Backend CRON scheduler ----------------------------------------------------
// Jobs live outside the replaceable project tree so patches do not reset them.
let cronScheduler = null;
const cronEventClients = new Set();
function emitCronEvent(event){
  const payload=`data: ${JSON.stringify(event)}\n\n`;
  for(const client of [...cronEventClients]){try{client.write(payload)}catch{cronEventClients.delete(client)}}
}
function localDateString(date=new Date()){
  const y=date.getFullYear(),m=String(date.getMonth()+1).padStart(2,'0'),d=String(date.getDate()).padStart(2,'0');
  return `${y}-${m}-${d}`;
}

// Persistent terminal website shortcuts --------------------------------------
// These are shell-style aliases such as `yt` -> https://www.youtube.com.
const terminalShortcutsFile = path.join(root, 'config', 'terminal-shortcuts.json');
const RESERVED_TERMINAL_COMMANDS = new Set([
  'help','clear','echo','date','system','news','weather','agenda','processes','network',
  'disks','services','launch','notes','todo','clipboard','bookmarks','timer','palette',
  'riftbreakers','vtt','ai','agent','os','osagent','research','skill','skilleditor','tooleditor','cron','tasks','reminders','devmode','terminal','refresh','whoami',
  'open','search','shortcuts','addshortcut','minimize','restore','background',
  'alias','unalias','aliases'
]);
function normalizeTerminalShortcutName(value) {
  const name = String(value || '').trim().toLowerCase();
  return /^[a-z][a-z0-9_-]{0,31}$/.test(name) ? name : '';
}
function normalizeWebsiteUrl(value) {
  let url = String(value || '').trim();
  if (!url) return '';
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  try {
    const parsed = new URL(url);
    if (!/^https?:$/.test(parsed.protocol)) return '';
    return parsed.toString();
  } catch { return ''; }
}
function readTerminalShortcuts() {
  try {
    const data = JSON.parse(fs.readFileSync(terminalShortcutsFile, 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch { return {}; }
}
function writeTerminalShortcuts(data) {
  fs.mkdirSync(path.dirname(terminalShortcutsFile), {recursive:true});
  fs.writeFileSync(terminalShortcutsFile, JSON.stringify(data, null, 2) + '\n', 'utf8');
}
app.get('/api/terminal-shortcuts', (_req,res)=>res.json({shortcuts:readTerminalShortcuts()}));
app.post('/api/terminal-shortcuts', (req,res)=>{
  const rawNames = Array.isArray(req.body?.names) ? req.body.names : [req.body?.name];
  const names = [...new Set(rawNames.flatMap(x=>String(x||'').split(',')).map(normalizeTerminalShortcutName).filter(Boolean))];
  const url = normalizeWebsiteUrl(req.body?.url);
  if (!names.length) return res.status(400).json({error:'Shortcut name must start with a letter and use only letters, numbers, _ or -.'});
  if (!url) return res.status(400).json({error:'A valid http(s) website URL is required.'});
  const reserved = names.find(name=>RESERVED_TERMINAL_COMMANDS.has(name));
  if (reserved) return res.status(409).json({error:`${reserved} is a built-in terminal command.`});
  const shortcuts = readTerminalShortcuts();
  for (const name of names) shortcuts[name] = url;
  writeTerminalShortcuts(shortcuts);
  res.json({ok:true,names,url,shortcuts});
});
app.delete('/api/terminal-shortcuts/:name', (req,res)=>{
  const names = [...new Set(String(req.params.name||'').split(',').map(normalizeTerminalShortcutName).filter(Boolean))];
  if (!names.length) return res.status(400).json({error:'Invalid shortcut name.'});
  const shortcuts = readTerminalShortcuts();
  const removed = [];
  for (const name of names) {
    if (Object.hasOwn(shortcuts,name)) { delete shortcuts[name]; removed.push(name); }
  }
  writeTerminalShortcuts(shortcuts);
  res.json({ok:true,removed,shortcuts});
});
// Never expose Tiny Web Agent's database, attachments, profile, or Python source over HTTP.
app.use('/private', (_req,res)=>res.status(404).end());
// The published Outlook ICS URL is a bearer-style private link. Never serve it as a static file.
app.use('/config/outlook.json', (_req,res)=>res.status(404).end());
app.use(express.static(root, {
  etag: false,
  lastModified: false,
  setHeaders(res, filePath) {
    if (/\.(?:html|js|css)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  }
}));

const rssFeeds = {
  cbc: { name: 'CBC', url: 'https://www.cbc.ca/cmlink/rss-topstories' },
  bbc: { name: 'BBC World', url: 'https://feeds.bbci.co.uk/news/world/rss.xml' },
  ars: { name: 'Ars Technica', url: 'https://feeds.arstechnica.com/arstechnica/index' },
  reuters: { name: 'Reuters World', url: 'https://feeds.reuters.com/reuters/worldNews' }
};


// CPU monitoring -----------------------------------------------------------
//
// Keep this deliberately lightweight. The previous build kept a PowerShell
// CIM/WMI sampler alive and queried Win32_Processor every two seconds. On some
// Windows systems that can cause substantial background I/O in the System/WMI
// processes. CPU load is now calculated from Node's os.cpus() counters only.

let lastCpuSnapshot = null;
function cpuSnapshot() {
  return os.cpus().map(cpu => {
    const times = cpu.times || {};
    const idle = Number(times.idle || 0);
    const total = Object.values(times).reduce((sum, value) => sum + Number(value || 0), 0);
    return { idle, total };
  });
}
function cpuLoadFromSnapshots(previous, current) {
  if (!previous || previous.length !== current.length) return null;
  const cores = current.map((cur, index) => {
    const prev = previous[index];
    const totalDelta = Math.max(0, cur.total - prev.total);
    const idleDelta = Math.max(0, cur.idle - prev.idle);
    if (!totalDelta) return 0;
    return Math.max(0, Math.min(100, (1 - idleDelta / totalDelta) * 100));
  });
  const prevTotal = previous.reduce((sum, x) => sum + x.total, 0);
  const prevIdle = previous.reduce((sum, x) => sum + x.idle, 0);
  const curTotal = current.reduce((sum, x) => sum + x.total, 0);
  const curIdle = current.reduce((sum, x) => sum + x.idle, 0);
  const totalDelta = Math.max(0, curTotal - prevTotal);
  const idleDelta = Math.max(0, curIdle - prevIdle);
  const load = totalDelta ? Math.max(0, Math.min(100, (1 - idleDelta / totalDelta) * 100)) : 0;
  return { load, cores, source: 'node-cpu-time' };
}
async function getCpuLoad() {
  const current = cpuSnapshot();
  let result = cpuLoadFromSnapshots(lastCpuSnapshot, current);
  lastCpuSnapshot = current;
  if (!result) {
    await new Promise(resolve => setTimeout(resolve, 250));
    const next = cpuSnapshot();
    result = cpuLoadFromSnapshots(lastCpuSnapshot, next) || { load: 0, cores: [], source: 'node-cpu-time' };
    lastCpuSnapshot = next;
  }
  return result;
}

let nvidiaStatsCache={at:0,value:null};
async function getNvidiaStats(force=false) {
  // nvidia-smi is a real subprocess. Fifteen seconds is plenty for a desktop
  // dashboard and avoids spawning it on every system-monitor refresh.
  if(!force && Date.now()-nvidiaStatsCache.at<15000)return nvidiaStatsCache.value;
  try {
    const { stdout } = await execFileAsync('nvidia-smi', ['--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu','--format=csv,noheader,nounits'], { windowsHide:true, timeout:3000 });
    const line = stdout.trim().split(/\r?\n/)[0]; if (!line) return null;
    const [name,gpu,memUsed,memTotal,temp] = line.split(',').map(v=>v.trim());
    const value={ name, utilization:Number(gpu), memoryUsedMb:Number(memUsed), memoryTotalMb:Number(memTotal), temperature:Number(temp) };
    nvidiaStatsCache={at:Date.now(),value};return value;
  } catch { nvidiaStatsCache={at:Date.now(),value:null};return null; }
}

const systemSlowCache={
  graphics:{at:0,value:{controllers:[]}},
  fs:{at:0,value:[]},
  battery:{at:0,value:null},
  cpuTemp:{at:0,value:{main:null}},
  cpuInfo:{at:0,value:null}
};
async function cachedSlow(key,ttl,loader){
  const slot=systemSlowCache[key];
  if(slot && Date.now()-slot.at<ttl)return slot.value;
  const value=await loader();systemSlowCache[key]={at:Date.now(),value};return value;
}

app.get('/api/system', async (_req,res)=>{
  try {
    const [cpuLoad,fsSize,graphics,cpuTemp,battery,nvidia,cpuInfo] = await Promise.all([
      getCpuLoad(),
      cachedSlow('fs',60000,()=>si.fsSize()),
      cachedSlow('graphics',300000,()=>si.graphics()),
      cachedSlow('cpuTemp',30000,()=>si.cpuTemperature()),
      cachedSlow('battery',60000,()=>si.battery()),
      getNvidiaStats(),
      cachedSlow('cpuInfo',300000,()=>si.cpu())
    ]);
    const totalMem=os.totalmem();
    const freeMem=os.freemem();
    const mem={used:totalMem-freeMem,active:totalMem-freeMem,total:totalMem,available:freeMem};
    const time={uptime:os.uptime()};
    const seenDisks=new Set();
    const disks=(fsSize||[])
      .filter(d=>Number(d?.size)>0 && (d?.mount || d?.fs))
      .filter(d=>{
        const key=String(d.mount||d.fs||'').trim().toUpperCase();
        if(!key || seenDisks.has(key))return false;
        seenDisks.add(key);return true;
      })
      .map(d=>({
        fs:d.fs||'', mount:d.mount||d.fs||'', type:d.type||'',
        used:Number(d.used)||0, size:Number(d.size)||0,
        available:Number.isFinite(Number(d.available))?Number(d.available):Math.max(0,(Number(d.size)||0)-(Number(d.used)||0)),
        use:Number(d.use)||0
      }))
      .sort((a,b)=>String(a.mount||a.fs).localeCompare(String(b.mount||b.fs),undefined,{numeric:true,sensitivity:'base'}));
    const mainDisk = disks.find(d=>/^C:\?$/i.test(String(d.mount||d.fs))) || disks[0] || null;
    const fallbackGpu = graphics.controllers?.[0] || null;
    const logicalProcessors=Number(cpuInfo?.cores)||os.cpus().length||0;
    const physicalCores=Number(cpuInfo?.physicalCores)||null;
    const processors=Number(cpuInfo?.processors)||1;
    res.json({
      cpu:{
        load:Math.round(cpuLoad.load||0),
        cores:(cpuLoad.cores||[]).map(x=>Math.round(x||0)),
        physicalCores, logicalProcessors, processors,
        manufacturer:cpuInfo?.manufacturer||'', brand:cpuInfo?.brand||'',
        temperature:cpuTemp.main||null, source:cpuLoad.source||'unknown'
      },
      memory:{used:mem.active||mem.used,total:mem.total,available:mem.available},
      gpu:nvidia||(fallbackGpu?{name:fallbackGpu.model||fallbackGpu.name||'GPU',utilization:fallbackGpu.utilizationGpu??null,memoryUsedMb:fallbackGpu.memoryUsed??null,memoryTotalMb:fallbackGpu.vram??null,temperature:fallbackGpu.temperatureGpu??null}:null),
      // Keep `disk` for compatibility with older clients, but expose every detected drive in `disks`.
      disk:mainDisk, disks,
      battery,time,uptime:time.uptime
    });
  } catch(e){res.status(500).json({error:e.message})}
});

app.get('/api/disks', async (_req,res)=>{try{res.json(await si.fsSize())}catch(e){res.status(500).json({error:e.message})}});
app.post('/api/system/open-drive', async (req,res)=>{
  try {
    if (process.platform !== 'win32') return res.status(400).json({error:'Opening drive roots is only supported on Windows.'});
    const requested=String(req.body?.mount||'').trim();
    if(!/^[A-Za-z]:\\?$/.test(requested)) return res.status(400).json({error:'A valid Windows drive root is required.'});
    const normalized=requested.slice(0,2).toUpperCase()+'\\';
    const fsSize=await si.fsSize();
    const allowed=(fsSize||[]).some(d=>{
      const value=String(d.mount||d.fs||'').trim();
      if(!value)return false;
      const candidate=/^[A-Za-z]:\\?$/.test(value)?value.slice(0,2).toUpperCase()+'\\':value.toUpperCase();
      return candidate===normalized.toUpperCase();
    });
    if(!allowed)return res.status(404).json({error:'That drive is not currently mounted or reported by BrowserOS.'});
    if(!fs.existsSync(normalized)) return res.status(404).json({error:`Drive ${normalized} is not accessible.`});

    const child=spawn('explorer.exe',[normalized],{stdio:'ignore',windowsHide:false});
    let replied=false;
    const fail=(error)=>{
      if(replied)return; replied=true;
      res.status(500).json({error:`Could not start File Explorer: ${error.message}`});
    };
    child.once('error', fail);
    child.once('spawn', ()=>{
      if(replied)return; replied=true;
      child.unref();
      res.json({ok:true,mount:normalized});
    });
  } catch(e){res.status(500).json({error:e.message})}
});
app.get('/api/network', async (_req,res)=>{try{const [stats,ifs]=await Promise.all([si.networkStats(),si.networkInterfaces()]);const s=(stats||[]).sort((a,b)=>(b.rx_sec+b.tx_sec)-(a.rx_sec+a.tx_sec))[0]||{};const inf=(ifs||[]).find(x=>x.iface===s.iface)||{};res.json({interface:s.iface||inf.iface,rxSec:s.rx_sec||0,txSec:s.tx_sec||0,rxBytes:s.rx_bytes||0,txBytes:s.tx_bytes||0,ip4:inf.ip4,ip6:inf.ip6})}catch(e){res.status(500).json({error:e.message})}});
app.get('/api/processes', async (req,res)=>{try{const sort=String(req.query.sort||'cpu').toLowerCase()==='ram'?'mem':'cpu';const p=await si.processes();const list=(p.list||[]).filter(x=>{const name=String(x.name||'').trim().toLowerCase();return Number(x.pid)!==0 && name!=='system idle process' && name!=='idle';});res.json(list.sort((a,b)=>(Number(b[sort])||0)-(Number(a[sort])||0)).slice(0,40).map(x=>({pid:x.pid,name:x.name,cpu:x.cpu,mem:x.mem}))) }catch(e){res.status(500).json({error:e.message})}});

function chromeBookmarksBase(){
  if(process.platform==='win32' && process.env.LOCALAPPDATA) return path.join(process.env.LOCALAPPDATA,'Google','Chrome','User Data');
  if(process.platform==='darwin' && process.env.HOME) return path.join(process.env.HOME,'Library','Application Support','Google','Chrome');
  if(process.env.HOME) return path.join(process.env.HOME,'.config','google-chrome');
  return null;
}
function flattenChromeBookmarks(node, out, folder='', profile=''){
  if(!node) return;
  if(Array.isArray(node)){ for(const x of node) flattenChromeBookmarks(x,out,folder,profile); return; }
  if(node.type==='url' && node.url){ out.push({name:node.name||node.url,url:node.url,folder,profile,source:'chrome'}); return; }
  const nextFolder=node.type==='folder' && node.name ? (folder?folder+' / '+node.name:node.name) : folder;
  if(Array.isArray(node.children)) flattenChromeBookmarks(node.children,out,nextFolder,profile);
}
app.get('/api/chrome-bookmarks', (_req,res)=>{
  try{
    const base=chromeBookmarksBase();
    if(!base || !fs.existsSync(base)) return res.json({available:false,profiles:[],bookmarks:[],error:'Chrome profile directory not found.'});
    const dirs=fs.readdirSync(base,{withFileTypes:true}).filter(d=>d.isDirectory() && (d.name==='Default' || /^Profile \d+$/.test(d.name))).map(d=>d.name);
    const profiles=[], bookmarks=[];
    for(const profile of dirs){
      const file=path.join(base,profile,'Bookmarks');
      if(!fs.existsSync(file)) continue;
      try{
        const data=JSON.parse(fs.readFileSync(file,'utf8')); const before=bookmarks.length;
        for(const [rootName,rootNode] of Object.entries(data.roots||{})){
          const label=rootName==='bookmark_bar'?'Bookmarks bar':rootName==='other'?'Other bookmarks':rootName==='synced'?'Mobile bookmarks':rootName;
          flattenChromeBookmarks(rootNode,bookmarks,label,profile);
        }
        profiles.push({name:profile,count:bookmarks.length-before});
      }catch{}
    }
    res.json({available:profiles.length>0,profiles,bookmarks});
  }catch(e){res.status(500).json({error:e.message,available:false,profiles:[],bookmarks:[]})}
});

// Windows application launcher ------------------------------------------------
// config/apps.json remains useful for explicit executables, while Get-StartApps
// discovers normal Win32/Store apps registered with the Windows Start menu.
let windowsAppsCache = { at: 0, apps: [] };
async function discoverWindowsApps(force=false) {
  if (!force && Date.now() - windowsAppsCache.at < 60000) return windowsAppsCache.apps;
  try {
    const ps = [
      '$ErrorActionPreference = \'SilentlyContinue\'',
      'Get-StartApps | Select-Object Name,AppID | Sort-Object Name | ConvertTo-Json -Compress'
    ].join('; ');
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile','-NonInteractive','-Command', ps], {
      windowsHide:true, timeout:15000, maxBuffer:4*1024*1024
    });
    let rows = JSON.parse(String(stdout || '[]').trim() || '[]');
    if (!Array.isArray(rows)) rows = rows ? [rows] : [];
    windowsAppsCache = {
      at: Date.now(),
      apps: rows.filter(x=>x && x.Name && x.AppID).map(x=>({
        id:String(x.AppID), name:String(x.Name), source:'windows', appId:String(x.AppID)
      }))
    };
  } catch (error) {
    console.warn('Windows app discovery failed:', error.message);
    if (!windowsAppsCache.at) windowsAppsCache = { at: Date.now(), apps: [] };
  }
  return windowsAppsCache.apps;
}
function configuredApps() {
  return readJson('config/apps.json').map(x=>({
    id:String(x.id), name:String(x.name || x.id), source:'configured',
    command:String(x.command || ''), args:Array.isArray(x.args)?x.args:[]
  }));
}

function normalizeAppSearch(value) {
  return String(value || '')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim().replace(/\s+/g, ' ');
}
function levenshteinDistance(a, b) {
  // Optimal-string-alignment Damerau-Levenshtein: common adjacent-letter
  // transpositions (e.g. stema -> steam) count as one typo.
  a=String(a||''); b=String(b||'');
  const rows=a.length+1, cols=b.length+1;
  const d=Array.from({length:rows},()=>new Array(cols).fill(0));
  for(let i=0;i<rows;i++) d[i][0]=i;
  for(let j=0;j<cols;j++) d[0][j]=j;
  for(let i=1;i<rows;i++){
    for(let j=1;j<cols;j++){
      const cost=a[i-1]===b[j-1]?0:1;
      d[i][j]=Math.min(d[i-1][j]+1,d[i][j-1]+1,d[i-1][j-1]+cost);
      if(i>1&&j>1&&a[i-1]===b[j-2]&&a[i-2]===b[j-1])
        d[i][j]=Math.min(d[i][j],d[i-2][j-2]+1);
    }
  }
  return d[a.length][b.length];
}
function appSimilarity(query, name) {
  const q=normalizeAppSearch(query), n=normalizeAppSearch(name);
  if(!q || !n) return 0;
  if(q===n) return 1;
  if(n.startsWith(q)) return Math.max(.94, q.length/n.length);
  if(n.includes(q)) return .90;
  const full=1-(levenshteinDistance(q,n)/Math.max(q.length,n.length));
  const qTokens=q.split(' '), nTokens=n.split(' ');
  let tokenTotal=0;
  for(const qt of qTokens){
    let best=0;
    for(const nt of nTokens){
      if(qt===nt){best=1;break;}
      if(nt.startsWith(qt)) best=Math.max(best,.94);
      else if(nt.includes(qt)) best=Math.max(best,.88);
      const sim=1-(levenshteinDistance(qt,nt)/Math.max(qt.length,nt.length));
      best=Math.max(best,sim);
    }
    tokenTotal+=best;
  }
  const tokenScore=tokenTotal/qTokens.length;
  return Math.max(full, tokenScore*0.96);
}
async function allWindowsApps(force=false) {
  const configured=configuredApps();
  const discovered=await discoverWindowsApps(force);
  const seen=new Set();
  return [...configured,...discovered].filter(a=>{
    const key=normalizeAppSearch(a.name);
    if(!key || seen.has(key)) return false;
    seen.add(key); return true;
  }).sort((a,b)=>a.name.localeCompare(b.name,undefined,{sensitivity:'base'}));
}
function rankWindowsApps(query, apps, limit=5) {
  return apps.map(app=>({...app,score:appSimilarity(query,app.name)}))
    .sort((a,b)=>b.score-a.score || a.name.length-b.name.length || a.name.localeCompare(b.name))
    .slice(0,limit);
}
app.get('/api/apps', async (req,res)=>{
  const configured=configuredApps();
  const discovered=await discoverWindowsApps(req.query.refresh === '1');
  const apps=await allWindowsApps(false);
  res.json({apps,configured:configured.length,discovered:discovered.length});
});
app.get('/api/apps/match', async (req,res)=>{
  const query=String(req.query.q||'').trim();
  if(!query) return res.status(400).json({error:'Missing app name'});
  try{
    const ranked=rankWindowsApps(query,await allWindowsApps(false),5);
    const best=ranked[0]||null, second=ranked[1]||null;
    const confident=!!best && (best.score>=0.74) && (!second || best.score-second.score>=0.035 || best.score>=0.94);
    res.json({query,best,confident,candidates:ranked});
  }catch(e){res.status(500).json({error:e.message});}
});
app.post('/api/apps/launch-match', async (req,res)=>{
  const query=String(req.body?.query || '').trim();
  if(!query) return res.status(400).json({error:'Missing app name'});
  try {
    const ranked=rankWindowsApps(query,await allWindowsApps(false),1);
    const app=ranked[0];
    if(!app) return res.status(404).json({error:`No installed app matched "${query}"`});
    if (app.source === 'configured') {
      const a=readJson('config/apps.json').find(x=>String(x.id)===String(app.id));
      if(!a) return res.status(404).json({error:'Matched configured app is unavailable'});
      const child=spawn(a.command,Array.isArray(a.args)?a.args:[],{detached:true,stdio:'ignore',windowsHide:false});
      child.unref();
    } else {
      const child=spawn('explorer.exe',[`shell:AppsFolder\\${app.appId}`],{detached:true,stdio:'ignore',windowsHide:false});
      child.unref();
    }
    return res.json({ok:true,query,name:app.name,id:app.id,source:app.source,score:app.score});
  } catch(e){ return res.status(500).json({error:e.message}); }
});
app.post('/api/apps/launch', async (req,res)=>{
  const source=String(req.body?.source || '');
  const id=String(req.body?.id || '');
  try {
    if (source === 'configured') {
      const a=readJson('config/apps.json').find(x=>String(x.id)===id);
      if(!a) return res.status(404).json({error:'Unknown configured app'});
      const child=spawn(a.command,Array.isArray(a.args)?a.args:[],{detached:true,stdio:'ignore',windowsHide:false});
      child.unref(); return res.json({ok:true,name:a.name||a.id});
    }
    const apps=await discoverWindowsApps(false);
    const a=apps.find(x=>x.id===id);
    if(!a) return res.status(404).json({error:'Unknown Windows app'});
    const child=spawn('explorer.exe',[`shell:AppsFolder\\${a.appId}`],{detached:true,stdio:'ignore',windowsHide:false});
    child.unref(); return res.json({ok:true,name:a.name});
  } catch(e){ return res.status(500).json({error:e.message}); }
});
// Backwards-compatible route used by the existing agent tool.
app.post('/api/apps/:id/launch', (req,res)=>{const a=readJson('config/apps.json').find(x=>String(x.id)===req.params.id);if(!a)return res.status(404).json({error:'Unknown app'});try{const child=spawn(a.command,Array.isArray(a.args)?a.args:[],{detached:true,stdio:'ignore',windowsHide:false});child.unref();res.json({ok:true})}catch(e){res.status(500).json({error:e.message})}});

function checkService(s){return new Promise(resolve=>{const sock=net.createConnection({host:s.host||'127.0.0.1',port:Number(s.port),timeout:800},()=>{sock.destroy();resolve({...s,online:true})});sock.on('timeout',()=>{sock.destroy();resolve({...s,online:false})});sock.on('error',()=>resolve({...s,online:false}))})}
app.get('/api/services', async (_req,res)=>res.json(await Promise.all(readJson('config/services.json').map(checkService))));



// Tiny Web Agent supervisor -------------------------------------------------
// The Python web service is started lazily when the Browser-OS AI window opens.
// Starting the Flask service does NOT load a GGUF model; llama.cpp loads only
// when the agent actually needs the selected model.
const agentDir = path.join(root, 'private', 'tiny-web-agent');
const agentHost = '127.0.0.1';
const configuredAgentPort = Number(process.env.TINY_AGENT_PORT || 7860);
let agentPort = configuredAgentPort;
let agentUrl = `http://${agentHost}:${agentPort}`;
let agentProcess = null;
let agentLastError = null;
let agentStarting = null;

function portOpen(host, port, timeout=450){
  return new Promise(resolve=>{
    const sock=net.createConnection({host,port});
    let done=false;
    const finish=v=>{if(done)return;done=true;try{sock.destroy()}catch{};resolve(v)};
    sock.setTimeout(timeout);
    sock.once('connect',()=>finish(true));
    sock.once('timeout',()=>finish(false));
    sock.once('error',()=>finish(false));
  });
}
function sameLocalPath(a,b){
  const normalize=v=>path.resolve(String(v||'')).replace(/[\\/]+$/,'').toLowerCase();
  return !!a && !!b && normalize(a)===normalize(b);
}
async function probeAgentIdentity(port=agentPort){
  const url=`http://${agentHost}:${port}/api/identity`;
  try{
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),700);
    const response=await fetch(url,{cache:'no-store',signal:controller.signal});
    clearTimeout(timer);
    if(!response.ok) return null;
    return await response.json().catch(()=>null);
  }catch{return null;}
}
async function chooseUsableAgentPort(){
  // Prefer the configured port. If a stale/older Tiny Agent or another process
  // owns it, do not silently embed that service: choose a nearby free port.
  for(let offset=0;offset<20;offset++){
    const candidate=configuredAgentPort+offset;
    if(!(await portOpen(agentHost,candidate))){
      agentPort=candidate; agentUrl=`http://${agentHost}:${agentPort}`;
      return {reuse:false,port:candidate};
    }
    const identity=await probeAgentIdentity(candidate);
    if(identity?.kind==='tiny-web-agent' && Number(identity.api_version)===3 && sameLocalPath(identity.app_dir,agentDir)){
      agentPort=candidate; agentUrl=`http://${agentHost}:${agentPort}`;
      return {reuse:true,port:candidate};
    }
  }
  throw new Error(`No free Tiny Web Agent port found near ${configuredAgentPort}.`);
}
async function agentStatus(){
  const online=await portOpen(agentHost,agentPort);
  return {online,starting:!!agentStarting,pid:agentProcess?.pid||null,url:agentUrl,error:agentLastError};
}
const agentPythonConfigFile = path.join(root, 'config', 'tiny-agent-python.txt');
let pythonCandidateCache = {at:0, commands:[], diagnostics:[]};
function isPyLauncher(command){
  const base=path.basename(String(command||'')).toLowerCase();
  return base==='py' || base==='py.exe';
}
function rawPythonCandidates(){
  const out=[];
  const push=value=>{const v=String(value||'').trim();if(v && !out.some(x=>x.toLowerCase()===v.toLowerCase()))out.push(v)};
  push(process.env.TINY_AGENT_PYTHON);
  try{push(fs.readFileSync(agentPythonConfigFile,'utf8'))}catch{}
  push(process.env.PYTHON);
  if(process.platform==='win32'){ push('python'); push('py'); }
  else { push('python3'); push('python'); }
  return out;
}
function pythonCandidates(){
  // Probe candidates before using them. This prevents a missing fallback such as
  // `py.exe` from masking the real error from an otherwise valid `python`.
  const now=Date.now();
  if(now-pythonCandidateCache.at < 30000) return [...pythonCandidateCache.commands];
  const commands=[]; const diagnostics=[];
  for(const command of rawPythonCandidates()){
    const args=isPyLauncher(command) ? ['-3.12','-c','import sys; print(sys.executable)'] : ['-c','import sys; print(sys.executable)'];
    const check=spawnSync(command,args,{windowsHide:true,encoding:'utf8',timeout:5000});
    if(check.error){diagnostics.push(`${command}: ${check.error.message}`);continue}
    if(check.status!==0){
      const detail=String(check.stderr||check.stdout||`exit ${check.status}`).trim().replace(/\s+/g,' ').slice(0,300);
      diagnostics.push(`${command}: ${detail||`exit ${check.status}`}`);continue;
    }
    commands.push(command);
    diagnostics.push(`${command}: OK (${String(check.stdout||'').trim()||'Python'})`);
  }
  pythonCandidateCache={at:now,commands:[...commands],diagnostics};
  return commands;
}
function pythonDiagnostics(){ pythonCandidates(); return [...pythonCandidateCache.diagnostics]; }


// Local voice transcription ------------------------------------------------
// A persistent faster-whisper worker is started lazily on first microphone
// use. This avoids reloading the model for every spoken command.
const whisperModelPath = process.env.BROWSER_OS_WHISPER_MODEL || path.join(__dirname, 'models', 'faster-whisper-small.en');
const whisperWorkerScript = path.join(root, 'private', 'voice', 'whisper_worker.py');
let whisperProcess = null;
let whisperReady = null;
let whisperBackend = null;
let whisperCounter = 0;
const whisperPending = new Map();

function stopWhisperWorker(){
  if(whisperProcess){ try{whisperProcess.kill()}catch{} }
  whisperProcess=null; whisperReady=null; whisperBackend=null;
  for(const pending of whisperPending.values()) pending.reject(new Error('Whisper worker stopped.'));
  whisperPending.clear();
}

function startWhisperWith(command){
  return new Promise((resolve,reject)=>{
    const isPyLauncher = command.toLowerCase().endsWith('py.exe') || command.toLowerCase()==='py';
    const args = isPyLauncher ? ['-3.12', whisperWorkerScript] : [whisperWorkerScript];
    const child=spawn(command,args,{
      cwd:root,
      windowsHide:true,
      stdio:['pipe','pipe','pipe'],
      env:{...process.env,PYTHONUNBUFFERED:'1',BROWSER_OS_WHISPER_MODEL:whisperModelPath}
    });
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    let buffer=''; let settled=false;
    const fail=(err)=>{if(settled)return;settled=true;try{child.kill()}catch{};reject(err)};
    const timer=setTimeout(()=>fail(new Error('Whisper worker timed out while loading the model.')),45000);
    child.stdout.on('data',chunk=>{
      buffer+=String(chunk||'');
      while(buffer.includes('\n')){
        const idx=buffer.indexOf('\n');
        const line=buffer.slice(0,idx).trim(); buffer=buffer.slice(idx+1);
        if(!line) continue;
        let msg; try{msg=JSON.parse(line)}catch{continue}
        if(msg.event==='ready'){
          clearTimeout(timer);
          if(!msg.ok) return fail(new Error(msg.error||'Whisper failed to initialize.'));
          if(settled)return; settled=true;
          whisperProcess=child; whisperBackend=msg.backend||null;
          resolve({process:child,backend:whisperBackend});
          continue;
        }
        if(msg.id && whisperPending.has(String(msg.id))){
          const pending=whisperPending.get(String(msg.id)); whisperPending.delete(String(msg.id));
          msg.ok ? pending.resolve(msg) : pending.reject(new Error(msg.error||'Transcription failed.'));
        }
      }
    });
    child.stderr.on('data',d=>{const t=String(d||'').trim();if(t)console.error('[Whisper]',t)});
    child.once('error',err=>fail(new Error(`${command}: ${err.message}`)));
    child.once('exit',(code,signal)=>{
      if(whisperProcess===child){whisperProcess=null;whisperReady=null;whisperBackend=null;}
      if(!settled) fail(new Error(`Whisper worker exited with code ${code}${signal?` (${signal})`:''}.`));
      for(const pending of whisperPending.values()) pending.reject(new Error('Whisper worker exited.'));
      whisperPending.clear();
    });
  });
}

async function ensureWhisperWorker(){
  if(whisperProcess && whisperProcess.exitCode===null) return {process:whisperProcess,backend:whisperBackend};
  if(whisperReady) return whisperReady;
  whisperReady=(async()=>{
    let lastErr=null;
    for(const command of pythonCandidates()){
      try{return await startWhisperWith(command)}catch(e){lastErr=e;}
    }
    throw lastErr||new Error('No usable Python installation found for faster-whisper.');
  })();
  try{return await whisperReady}catch(e){whisperReady=null;throw e;}
}

async function transcribeVoiceFile(filePath){
  const {process:child}=await ensureWhisperWorker();
  const id=String(++whisperCounter);
  return await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{
      whisperPending.delete(id);
      reject(new Error('Voice transcription timed out.'));
    },60000);
    whisperPending.set(id,{
      resolve:msg=>{clearTimeout(timer);resolve(msg)},
      reject:err=>{clearTimeout(timer);reject(err)}
    });
    try{child.stdin.write(JSON.stringify({id,path:filePath})+'\n')}catch(e){
      clearTimeout(timer); whisperPending.delete(id); reject(e);
    }
  });
}

app.get('/api/voice/status', async (_req,res)=>{
  res.json({
    model:whisperModelPath,
    modelExists:fs.existsSync(whisperModelPath),
    workerRunning:!!(whisperProcess&&whisperProcess.exitCode===null),
    backend:whisperBackend
  });
});

app.post('/api/voice/transcribe', express.raw({type:['audio/webm','audio/ogg','audio/wav','audio/mp4','application/octet-stream'],limit:'25mb'}), async (req,res)=>{
  if(!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({error:'No microphone audio received.'});
  const type=String(req.headers['content-type']||'').toLowerCase();
  const ext=type.includes('ogg')?'.ogg':type.includes('wav')?'.wav':type.includes('mp4')?'.m4a':'.webm';
  const dir=path.join(os.tmpdir(),'browser-os-voice');
  fs.mkdirSync(dir,{recursive:true});
  const file=path.join(dir,`voice-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}${ext}`);
  try{
    fs.writeFileSync(file,req.body);
    const result=await transcribeVoiceFile(file);
    res.json({ok:true,text:result.text||'',language:result.language||'en',backend:whisperBackend,model:whisperModelPath});
  }catch(e){
    res.status(503).json({error:String(e.message||e),model:whisperModelPath});
  }finally{
    try{fs.unlinkSync(file)}catch{}
  }
});
// Warm the local speech model in the background so first dictation is responsive.
setImmediate(()=>ensureWhisperWorker().catch(err=>console.warn('[Whisper] preload failed:', String(err.message||err))));

function spawnAgentWith(command){
  const args = command.toLowerCase().endsWith('py.exe') || command.toLowerCase()==='py'
    ? ['-3.12','web_main.py','--host',agentHost,'--port',String(agentPort),'--no-browser']
    : ['web_main.py','--host',agentHost,'--port',String(agentPort),'--no-browser'];
  const child=spawn(command,args,{cwd:agentDir,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,PYTHONUNBUFFERED:'1',BROWSER_OS_URL:`http://127.0.0.1:${port}`}});
  let settled=false;
  const failEarly=(err)=>{if(!settled){settled=true;try{child.kill()}catch{};throw err}};
  child.stdout?.setEncoding('utf8'); child.stderr?.setEncoding('utf8');
  child.stdout?.on('data',d=>{const t=String(d).trim();if(t)console.log('[Tiny Agent]',t)});
  child.stderr?.on('data',d=>{const t=String(d).trim();if(t){console.error('[Tiny Agent]',t);agentLastError=t.slice(-1000)}});
  child.on('exit',(code,signal)=>{if(agentProcess===child)agentProcess=null;if(code && code!==0)agentLastError=`Tiny Web Agent exited with code ${code}${signal?` (${signal})`:''}`;});
  child.on('error',err=>{agentLastError=`${command}: ${err.message}`});
  return child;
}
async function ensureAgentStarted(){
  const portChoice=await chooseUsableAgentPort();
  if(portChoice.reuse) return agentStatus();
  if(agentStarting) return agentStarting;
  agentLastError=null;
  agentStarting=(async()=>{
    const candidates=pythonCandidates();
    if(!candidates.length){
      const detail=pythonDiagnostics().join(' | ');
      agentLastError=`No usable Python executable found.${detail?` ${detail}`:''}`;
      throw new Error(agentLastError);
    }
    const failures=[];
    for(const command of candidates){
      try{
        agentLastError=null;
        const child=spawnAgentWith(command); agentProcess=child;
        // Importing Flask/llama-cpp/FastEmbed can take longer than the old 7 s
        // startup budget on Windows, so allow a reasonable local startup window.
        for(let i=0;i<80;i++){
          await new Promise(r=>setTimeout(r,250));
          if(await portOpen(agentHost,agentPort)) return agentStatus();
          if(child.exitCode!==null) break;
        }
        const reason=agentLastError||`${command} did not open port ${agentPort}.`;
        failures.push(`${command}: ${reason}`);
        try{if(child.exitCode===null)child.kill()}catch{}
      }catch(e){failures.push(`${command}: ${e.message||e}`);}
    }
    agentProcess=null;
    agentLastError=failures.join(' | ')||'Unable to start Tiny Web Agent.';
    throw new Error(agentLastError);
  })().finally(()=>{agentStarting=null});
  return agentStarting;
}
// Dedicated Browser-OS agent bridge ---------------------------------------
// The normal Tiny Web Agent chat stays at :7860 with its own history/tools.
// /api/os/query is a separate, short-lived context with only Browser-OS tools.
const osEventClients = new Set();
function emitOsCommand(command){
  const payload=`data: ${JSON.stringify(command)}\n\n`;
  for(const client of [...osEventClients]){try{client.write(payload)}catch{osEventClients.delete(client)}}
}
app.get('/api/os/events',(req,res)=>{
  res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive','X-Accel-Buffering':'no'});
  res.write(': Browser-OS agent command stream\n\n');
  osEventClients.add(res);
  const keep=setInterval(()=>{try{res.write(': ping\n\n')}catch{}},15000);
  req.on('close',()=>{clearInterval(keep);osEventClients.delete(res)});
});
app.post('/api/os/command',(req,res)=>{
  const action=String(req.body?.action||'').trim();
  const args=(req.body?.args && typeof req.body.args==='object')?req.body.args:{};
  const allowed=new Set(['window','note','todo','timer']);
  if(!allowed.has(action)) return res.status(400).json({ok:false,error:'Unsupported Browser-OS action.'});
  if(action==='window'){
    const windowAction=String(args.window_action||'').trim();
    const target=String(args.target||'').trim();
    const validActions=new Set(['open','close','minimize','restore']);
    const validTargets=new Set(['terminal','system','processes','network','disks','services','news','weather','agenda','clipboard','notes','todo','bookmarks','search','launcher','timers','background','riftbreakers','chat','research']);
    if(!validActions.has(windowAction)) return res.status(400).json({ok:false,error:`Invalid window action: ${windowAction||'(missing)'}.`});
    if(!validTargets.has(target)) return res.status(400).json({ok:false,error:`Invalid window target: ${target||'(missing)'}.`});
  }
  emitOsCommand({action,args,at:Date.now()});
  res.json({ok:true,message:`Browser-OS ${action} command accepted.`});
});
app.post('/api/os/stream',async(req,res)=>{
  const prompt=String(req.body?.prompt||'').trim();
  if(!prompt) return res.status(400).json({error:'Enter an OS instruction.'});
  try{
    await ensureAgentStarted();
    const upstream=await fetch(`${agentUrl}/api/os/stream`,{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({
        prompt,
        state:req.body?.state||{},
        devmode:!!(req.body?.devmode || req.body?.state?.__devmode),
        devsession:req.body?.devsession || req.body?.state?.__devsession || null,
        ossession:req.body?.ossession || req.body?.state?.__ossession || null,
        skill:req.body?.skill || req.body?.state?.__skill || null,
      }),
    });
    if(!upstream.ok || !upstream.body){
      const text=await upstream.text();
      return res.status(upstream.status).send(text);
    }
    res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive','X-Accel-Buffering':'no'});
    const reader=upstream.body.getReader();
    try{
      while(true){
        const {done,value}=await reader.read();
        if(done)break;
        res.write(Buffer.from(value));
      }
    }finally{res.end();}
  }catch(e){if(!res.headersSent)res.status(503).json({error:e.message});else res.end();}
});
app.post('/api/research/stream',async(req,res)=>{
  const query=String(req.body?.query||req.body?.prompt||'').trim();
  if(!query) return res.status(400).json({error:'Enter a research question.'});
  const sources=Math.max(3,Math.min(5,Number(req.body?.sources||4)));
  try{
    await ensureAgentStarted();
    const upstream=await fetch(`${agentUrl}/api/research/stream`,{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({query,sources}),
    });
    if(!upstream.ok || !upstream.body){
      const text=await upstream.text();
      return res.status(upstream.status).send(text);
    }
    res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive','X-Accel-Buffering':'no'});
    const reader=upstream.body.getReader();
    try{
      while(true){
        const {done,value}=await reader.read();
        if(done)break;
        res.write(Buffer.from(value));
      }
    }finally{res.end();}
  }catch(e){if(!res.headersSent)res.status(503).json({error:e.message});else res.end();}
});

app.post('/api/os/reset',async(req,res)=>{
  try{
    await ensureAgentStarted();
    const response=await fetch(`${agentUrl}/api/os/reset`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ossession:req.body?.ossession||null})});
    const data=await response.json().catch(()=>({error:`Tiny Web Agent returned HTTP ${response.status}`}));
    res.status(response.status).json(data);
  }catch(e){res.status(503).json({error:e.message})}
});

app.post('/api/os/query',async(req,res)=>{
  const prompt=String(req.body?.prompt||'').trim();
  if(!prompt) return res.status(400).json({error:'Enter an OS instruction.'});
  try{
    await ensureAgentStarted();
    const response=await fetch(`${agentUrl}/api/os`,{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({prompt,state:req.body?.state||{},ossession:req.body?.ossession||req.body?.state?.__ossession||null,skill:req.body?.skill||req.body?.state?.__skill||null}),
    });
    const data=await response.json().catch(()=>({error:`Tiny Web Agent returned HTTP ${response.status}`}));
    res.status(response.status).json(data);
  }catch(e){res.status(503).json({error:e.message})}
});

app.get('/api/os/skills',async(_req,res)=>{
  try{
    await ensureAgentStarted();
    const response=await fetch(`${agentUrl}/api/os/skills`,{cache:'no-store'});
    const data=await response.json().catch(()=>({error:`Tiny Web Agent returned HTTP ${response.status}`}));
    res.status(response.status).json(data);
  }catch(e){res.status(503).json({error:e.message})}
});
app.get('/api/os/tools',async(_req,res)=>{
  try{
    await ensureAgentStarted();
    const response=await fetch(`${agentUrl}/api/os/tools`,{cache:'no-store'});
    const data=await response.json().catch(()=>({error:`Tiny Web Agent returned HTTP ${response.status}`}));
    res.status(response.status).json(data);
  }catch(e){res.status(503).json({error:e.message})}
});
app.get('/api/os/tool-editor',async(_req,res)=>{
  try{
    await ensureAgentStarted();
    const response=await fetch(`${agentUrl}/api/os/tool-editor`,{cache:'no-store'});
    const data=await response.json().catch(()=>({error:`Tiny Web Agent returned HTTP ${response.status}`}));
    res.status(response.status).json(data);
  }catch(e){res.status(503).json({error:e.message})}
});
app.get('/api/os/tool-editor/:name',async(req,res)=>{
  try{
    await ensureAgentStarted();
    const response=await fetch(`${agentUrl}/api/os/tool-editor/${encodeURIComponent(req.params.name)}`,{cache:'no-store'});
    const data=await response.json().catch(()=>({error:`Tiny Web Agent returned HTTP ${response.status}`}));
    res.status(response.status).json(data);
  }catch(e){res.status(503).json({error:e.message})}
});
app.post('/api/os/tool-editor/validate',async(req,res)=>{
  try{
    await ensureAgentStarted();
    const response=await fetch(`${agentUrl}/api/os/tool-editor/validate`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(req.body||{})});
    const data=await response.json().catch(()=>({error:`Tiny Web Agent returned HTTP ${response.status}`}));
    res.status(response.status).json(data);
  }catch(e){res.status(503).json({error:e.message})}
});
app.post('/api/os/tool-editor/save',async(req,res)=>{
  try{
    await ensureAgentStarted();
    const response=await fetch(`${agentUrl}/api/os/tool-editor/save`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(req.body||{})});
    const data=await response.json().catch(()=>({error:`Tiny Web Agent returned HTTP ${response.status}`}));
    res.status(response.status).json(data);
  }catch(e){res.status(503).json({error:e.message})}
});
app.put('/api/os/tool-editor/:name',async(req,res)=>{
  try{
    await ensureAgentStarted();
    const response=await fetch(`${agentUrl}/api/os/tool-editor/${encodeURIComponent(req.params.name)}`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(req.body||{})});
    const data=await response.json().catch(()=>({error:`Tiny Web Agent returned HTTP ${response.status}`}));
    res.status(response.status).json(data);
  }catch(e){res.status(503).json({error:e.message})}
});
app.delete('/api/os/tool-editor/:name',async(req,res)=>{
  try{
    await ensureAgentStarted();
    const response=await fetch(`${agentUrl}/api/os/tool-editor/${encodeURIComponent(req.params.name)}`,{method:'DELETE'});
    const data=await response.json().catch(()=>({error:`Tiny Web Agent returned HTTP ${response.status}`}));
    res.status(response.status).json(data);
  }catch(e){res.status(503).json({error:e.message})}
});
app.get('/api/os/skills/:name',async(req,res)=>{
  try{
    await ensureAgentStarted();
    const response=await fetch(`${agentUrl}/api/os/skills/${encodeURIComponent(req.params.name)}`,{cache:'no-store'});
    const data=await response.json().catch(()=>({error:`Tiny Web Agent returned HTTP ${response.status}`}));
    res.status(response.status).json(data);
  }catch(e){res.status(503).json({error:e.message})}
});
app.post('/api/os/skills/validate',async(req,res)=>{
  try{
    await ensureAgentStarted();
    const response=await fetch(`${agentUrl}/api/os/skills/validate`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(req.body||{})});
    const data=await response.json().catch(()=>({error:`Tiny Web Agent returned HTTP ${response.status}`}));
    res.status(response.status).json(data);
  }catch(e){res.status(503).json({error:e.message})}
});
app.put('/api/os/skills/:name',async(req,res)=>{
  try{
    await ensureAgentStarted();
    const response=await fetch(`${agentUrl}/api/os/skills/${encodeURIComponent(req.params.name)}`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(req.body||{})});
    const data=await response.json().catch(()=>({error:`Tiny Web Agent returned HTTP ${response.status}`}));
    res.status(response.status).json(data);
  }catch(e){res.status(503).json({error:e.message})}
});
app.delete('/api/os/skills/:name',async(req,res)=>{
  try{
    await ensureAgentStarted();
    const response=await fetch(`${agentUrl}/api/os/skills/${encodeURIComponent(req.params.name)}`,{method:'DELETE'});
    const data=await response.json().catch(()=>({error:`Tiny Web Agent returned HTTP ${response.status}`}));
    res.status(response.status).json(data);
  }catch(e){res.status(503).json({error:e.message})}
});
app.post('/api/os/skills/teach',async(req,res)=>{
  try{
    await ensureAgentStarted();
    const response=await fetch(`${agentUrl}/api/os/skills/teach`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(req.body||{})});
    const data=await response.json().catch(()=>({error:`Tiny Web Agent returned HTTP ${response.status}`}));
    res.status(response.status).json(data);
  }catch(e){res.status(503).json({error:e.message})}
});
app.post('/api/os/skills/save',async(req,res)=>{
  try{
    await ensureAgentStarted();
    const response=await fetch(`${agentUrl}/api/os/skills/save`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(req.body||{})});
    const data=await response.json().catch(()=>({error:`Tiny Web Agent returned HTTP ${response.status}`}));
    res.status(response.status).json(data);
  }catch(e){res.status(503).json({error:e.message})}
});

app.get('/api/agent/status', async (_req,res)=>res.json(await agentStatus()));
app.get('/api/agent/python', (_req,res)=>res.json({candidates:pythonCandidates(),diagnostics:pythonDiagnostics(),configFile:agentPythonConfigFile}));
app.post('/api/agent/start', async (_req,res)=>{try{res.json(await ensureAgentStarted())}catch(e){res.status(503).json({error:e.message,...await agentStatus()})}});
app.post('/api/agent/stop', async (_req,res)=>{
  if(agentProcess){try{agentProcess.kill()}catch{} agentProcess=null;}
  res.json({ok:true,...await agentStatus()});
});
function stopOwnedAgent(){cronScheduler?.stop();if(agentProcess){try{agentProcess.kill()}catch{} agentProcess=null;} stopWhisperWorker();}
process.once('SIGINT',()=>{stopOwnedAgent();process.exit(0)});
process.once('SIGTERM',()=>{stopOwnedAgent();process.exit(0)});
process.once('exit',stopOwnedAgent);

app.get('/api/rss', async (req,res)=>{try{const key=String(req.query.feed||'cbc').toLowerCase(),feed=rssFeeds[key]||rssFeeds.cbc,parsed=await parser.parseURL(feed.url);res.json({key,name:feed.name,items:(parsed.items||[]).slice(0,30).map(item=>({title:item.title||'Untitled',link:item.link||'#',date:item.isoDate||item.pubDate||null,summary:item.contentSnippet||item.summary||''}))})}catch(e){res.status(502).json({error:e.message,items:[]})}});
app.get('/api/feeds', (_req,res)=>res.json(Object.entries(rssFeeds).map(([key,v])=>({key,name:v.name}))));

async function fetchWeatherData(city){
  city=String(city||'').trim();
  if(!city)throw new Error('Weather city is not configured.');
  const geo=await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=en&format=json`).then(r=>r.json());
  const loc=geo.results?.[0]; if(!loc)throw new Error('Weather location not found.');
  const url=`https://api.open-meteo.com/v1/forecast?latitude=${loc.latitude}&longitude=${loc.longitude}&current=temperature_2m,apparent_temperature,wind_speed_10m,weather_code&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code&timezone=auto&forecast_days=7`;
  const w=await fetch(url).then(r=>r.json());
  return {location:{name:loc.name,admin1:loc.admin1,country:loc.country},current:w.current,daily:w.daily};
}
app.get('/api/weather', async (req,res)=>{try{res.json(await fetchWeatherData(String(req.query.city||'Toronto')))}catch(e){res.status(502).json({error:e.message})}});

// Outlook calendar via a published ICS feed --------------------------------
//
// Reads are intentionally independent of Microsoft authentication. The private
// published feed URL is stored only in local server-side configuration and is
// never returned to the dashboard or Tiny Web Agent.
const browserOsDataRoot = process.env.LOCALAPPDATA
  ? path.join(process.env.LOCALAPPDATA, 'BrowserOS')
  : path.join(os.homedir(), '.browseros');
const outlookCompanionSourceDir = path.join(root, 'browser-extension', 'outlook-companion');
const outlookCompanionInstallDir = path.join(browserOsDataRoot, 'outlook-companion-extension');
const outlookCompanionTokenFile = path.join(browserOsDataRoot, 'outlook-companion-token.txt');
const outlookAutomationRequests = new Map();
let outlookCompanionLastSeen = 0;
let outlookCompanionBrowser = '';

function getOrCreateOutlookCompanionToken(){
  fs.mkdirSync(browserOsDataRoot,{recursive:true});
  try{
    const existing=fs.readFileSync(outlookCompanionTokenFile,'utf8').trim();
    if(existing.length>=32)return existing;
  }catch{}
  const token=crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(outlookCompanionTokenFile,token+'\n',{encoding:'utf8',mode:0o600});
  return token;
}
const outlookCompanionToken=getOrCreateOutlookCompanionToken();

function copyDirectoryContents(src,dst){
  if(!fs.existsSync(src))return;
  fs.mkdirSync(dst,{recursive:true});
  for(const entry of fs.readdirSync(src,{withFileTypes:true})){
    const from=path.join(src,entry.name),to=path.join(dst,entry.name);
    if(entry.isDirectory())copyDirectoryContents(from,to);
    else if(entry.isFile())fs.copyFileSync(from,to);
  }
}

function syncOutlookCompanionExtension(){
  try{
    copyDirectoryContents(outlookCompanionSourceDir,outlookCompanionInstallDir);
    const config=`globalThis.BROWSEROS_BRIDGE = ${JSON.stringify({baseUrl:`http://127.0.0.1:${port}`,token:outlookCompanionToken},null,2)};\n`;
    fs.writeFileSync(path.join(outlookCompanionInstallDir,'bridge-config.js'),config,'utf8');
    return true;
  }catch(error){
    console.warn('[outlook companion] could not prepare extension:',error?.message||error);
    return false;
  }
}
syncOutlookCompanionExtension();

function companionIsConnected(){return !!outlookCompanionLastSeen && Date.now()-outlookCompanionLastSeen<45000;}
function companionAuth(req,res,next){
  const supplied=String(req.get('X-BrowserOS-Outlook-Companion')||'');
  const a=Buffer.from(supplied),b=Buffer.from(outlookCompanionToken);
  if(a.length!==b.length||!crypto.timingSafeEqual(a,b))return res.status(403).json({error:'Invalid BrowserOS Outlook Companion token.'});
  next();
}
function cleanupOutlookAutomationRequests(){
  const now=Date.now();
  for(const [id,item] of outlookAutomationRequests){if(Number(item.expiresAt||0)<now)outlookAutomationRequests.delete(id);}
}
function publicAutomationRequest(item){
  if(!item)return null;
  return {
    id:item.id,status:item.status,error:item.error||'',detail:item.detail||'',autoSave:!!item.autoSave,
    createdAt:item.createdAt,updatedAt:item.updatedAt,event:item.event,expectedQuery:item.expectedQuery
  };
}

app.post('/api/outlook/automation/heartbeat', companionAuth, (req,res)=>{
  outlookCompanionLastSeen=Date.now();
  outlookCompanionBrowser=String(req.body?.browser||'').slice(0,500);
  res.json({ok:true,connected:true,build:BUILD_ID});
});
app.get('/api/outlook/automation/status', (_req,res)=>{
  cleanupOutlookAutomationRequests();
  res.json({
    connected:companionIsConnected(),lastSeen:outlookCompanionLastSeen||0,
    browser:outlookCompanionBrowser,installPath:outlookCompanionInstallDir,
    prepared:fs.existsSync(path.join(outlookCompanionInstallDir,'manifest.json')),
    method:'browser-extension'
  });
});
app.get('/api/outlook/automation/request/:id', companionAuth, (req,res)=>{
  cleanupOutlookAutomationRequests();
  const item=outlookAutomationRequests.get(String(req.params.id||''));
  if(!item)return res.status(404).json({error:'Outlook automation request not found or expired.'});
  outlookCompanionLastSeen=Date.now();
  res.json({ok:true,...publicAutomationRequest(item)});
});
app.post('/api/outlook/automation/request/:id/status', companionAuth, (req,res)=>{
  cleanupOutlookAutomationRequests();
  const item=outlookAutomationRequests.get(String(req.params.id||''));
  if(!item)return res.status(404).json({error:'Outlook automation request not found or expired.'});
  const allowed=new Set(['pending','opened','verified','save-clicked','saved','failed']);
  const status=String(req.body?.status||'').trim();
  if(!allowed.has(status))return res.status(400).json({error:'Invalid Outlook automation status.'});
  item.status=status;item.updatedAt=Date.now();item.detail=String(req.body?.detail||'').slice(0,1000);item.error=String(req.body?.error||'').slice(0,1000);
  if(status==='saved'||status==='failed')item.completedAt=Date.now();
  outlookCompanionLastSeen=Date.now();
  res.json({ok:true,...publicAutomationRequest(item)});
});
app.get('/api/outlook/automation/result/:id', (req,res)=>{
  cleanupOutlookAutomationRequests();
  const item=outlookAutomationRequests.get(String(req.params.id||''));
  if(!item)return res.status(404).json({error:'Outlook automation request not found or expired.'});
  res.json({ok:true,...publicAutomationRequest(item)});
});
const projectOutlookConfig = path.join(root, 'config', 'outlook.json');
const userOutlookConfig = path.join(browserOsDataRoot, 'outlook.json');
const DEFAULT_OUTLOOK_WEB_CALENDAR = 'https://outlook.live.com/calendar/0/view/month';
const DEFAULT_OUTLOOK_COMPOSE = 'https://outlook.live.com/calendar/0/deeplink/compose';
let outlookEventsCache={at:0,data:null};
// BrowserOS local-only calendar events --------------------------------------
// Stored outside the project tree so replacing BrowserOS does not erase them.
const localCalendarFile=path.join(browserOsDataRoot,'local-calendar.json');
function readLocalCalendarEvents(){
  try{
    const parsed=JSON.parse(fs.readFileSync(localCalendarFile,'utf8'));
    return Array.isArray(parsed)?parsed:[];
  }catch{return []}
}
function writeLocalCalendarEvents(events){
  fs.mkdirSync(path.dirname(localCalendarFile),{recursive:true});
  const temp=`${localCalendarFile}.tmp`;
  fs.writeFileSync(temp,JSON.stringify(events,null,2)+'\n','utf8');
  fs.renameSync(temp,localCalendarFile);
}
function normalizeLocalCalendarEvent(body={},existing=null){
  const subject=String(body.subject??body.title??existing?.subject??'').trim();
  if(!subject)throw new Error('Event title is required.');
  const startRaw=String(body.start??existing?.start??'').trim();
  if(!startRaw)throw new Error('Event start is required.');
  const start=new Date(startRaw); if(Number.isNaN(start.getTime()))throw new Error('Event start is invalid.');
  const allDay=!!(body.allDay??body.all_day??existing?.allDay??false);
  let endRaw=String(body.end??existing?.end??'').trim();
  let end=endRaw?new Date(endRaw):new Date(start.getTime()+(allDay?86400000:3600000));
  if(Number.isNaN(end.getTime())||end<=start)end=new Date(start.getTime()+(allDay?86400000:3600000));
  const now=new Date().toISOString();
  return {
    id:String(existing?.id||`local-${crypto.randomUUID()}`),
    uid:String(existing?.uid||`browseros-${crypto.randomUUID()}`),
    subject,
    start:start.toISOString(),
    end:end.toISOString(),
    allDay,
    location:String(body.location??existing?.location??'').trim(),
    source:'browseros-local',
    readOnly:false,
    createdAt:existing?.createdAt||now,
    updatedAt:now
  };
}
function localEventsForRange(start='',end=''){
  return filterEvents(readLocalCalendarEvents(),start,end).map(e=>({...e,source:'browseros-local',readOnly:false}));
}
function mergeCalendarEvents(outlookEvents=[],start='',end=''){
  const remote=filterEvents(outlookEvents,start,end).map(e=>({...e,source:'outlook',readOnly:true}));
  const local=localEventsForRange(start,end);
  return [...remote,...local].sort((a,b)=>new Date(a.start||0)-new Date(b.start||0));
}

app.get('/api/calendar/local-events',(req,res)=>{
  res.json({ok:true,events:localEventsForRange(String(req.query.start||''),String(req.query.end||''))});
});
app.post('/api/calendar/local-events',(req,res)=>{
  try{
    const events=readLocalCalendarEvents(); const event=normalizeLocalCalendarEvent(req.body||{});
    events.push(event); writeLocalCalendarEvents(events); res.json({ok:true,event});
  }catch(e){res.status(400).json({error:String(e.message||e)});}
});
app.put('/api/calendar/local-events/:id',(req,res)=>{
  try{
    const events=readLocalCalendarEvents(); const index=events.findIndex(e=>String(e.id)===String(req.params.id));
    if(index<0)return res.status(404).json({error:'Local event not found.'});
    const event=normalizeLocalCalendarEvent(req.body||{},events[index]);events[index]=event;writeLocalCalendarEvents(events);res.json({ok:true,event});
  }catch(e){res.status(400).json({error:String(e.message||e)});}
});
app.delete('/api/calendar/local-events/:id',(req,res)=>{
  const events=readLocalCalendarEvents();const next=events.filter(e=>String(e.id)!==String(req.params.id));
  if(next.length===events.length)return res.status(404).json({error:'Local event not found.'});
  writeLocalCalendarEvents(next);res.json({ok:true});
});

function readOutlookConfig(){
  try{
    fs.mkdirSync(browserOsDataRoot,{recursive:true});
    if(!fs.existsSync(userOutlookConfig) && fs.existsSync(projectOutlookConfig)){
      fs.copyFileSync(projectOutlookConfig,userOutlookConfig);
    }
  }catch{}
  for(const file of [userOutlookConfig,projectOutlookConfig]){
    try{
      const parsed=JSON.parse(fs.readFileSync(file,'utf8'));
      if(parsed&&typeof parsed==='object')return parsed;
    }catch{}
  }
  return {};
}

function outlookIcsConfig(){
  const cfg=readOutlookConfig();
  const icsUrl=String(cfg.icsUrl||cfg.ics_url||'').trim();
  if(!/^https:\/\//i.test(icsUrl))throw new Error('Outlook ICS feed is not configured.');
  return {
    method:'ics-feed',
    icsUrl,
    publishedPageUrl:String(cfg.publishedPageUrl||cfg.published_page_url||'').trim(),
    webCalendarUrl:String(cfg.webCalendarUrl||DEFAULT_OUTLOOK_WEB_CALENDAR).trim()||DEFAULT_OUTLOOK_WEB_CALENDAR,
    composeBaseUrl:String(cfg.composeBaseUrl||DEFAULT_OUTLOOK_COMPOSE).trim()||DEFAULT_OUTLOOK_COMPOSE,
  };
}

async function fetchOutlookIcs(){
  const cfg=outlookIcsConfig();
  const response=await fetch(cfg.icsUrl,{
    redirect:'follow',
    signal:AbortSignal.timeout(20000),
    headers:{
      'Accept':'text/calendar,text/plain;q=0.9,*/*;q=0.1',
      'User-Agent':'BrowserOS/1.0 Outlook-ICS'
    }
  });
  if(!response.ok)throw new Error(`Outlook ICS returned HTTP ${response.status}.`);
  const text=await response.text();
  if(text.length>12*1024*1024)throw new Error('Outlook ICS feed is unexpectedly large.');
  const events=parseIcsCalendar(text,{now:new Date()});
  return {account:'Outlook Web',events,scanned:events.length};
}

function buildOutlookComposeUrl(payload={}, requestId=''){
  const cfg=outlookIcsConfig();
  const subject=String(payload.subject||payload.title||'').trim();
  const startRaw=String(payload.start||'').trim();
  const endRaw=String(payload.end||'').trim();
  if(!subject||!startRaw)throw new Error('subject and start are required');
  const start=new Date(startRaw);
  if(Number.isNaN(start.getTime()))throw new Error('start must be a valid date/time');
  let end=endRaw?new Date(endRaw):new Date(start.getTime()+3600000);
  if(Number.isNaN(end.getTime())||end<=start)end=new Date(start.getTime()+3600000);
  const pad=n=>String(n).padStart(2,'0');
  const localIso=d=>`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const url=new URL(cfg.composeBaseUrl);
  url.searchParams.set('path','/calendar/action/compose');
  url.searchParams.set('rru','addevent');
  url.searchParams.set('allday',payload.allDay||payload.all_day?'true':'false');
  url.searchParams.set('subject',subject);
  url.searchParams.set('startdt',localIso(start));
  url.searchParams.set('enddt',localIso(end));
  const location=String(payload.location||'').trim();
  if(location)url.searchParams.set('location',location);
  if(requestId)url.searchParams.set('browseros_request',String(requestId));
  return url.toString();
}

function openExternalUrl(url){
  let child;
  if(process.platform==='win32') child=spawn('rundll32.exe',['url.dll,FileProtocolHandler',url],{detached:true,stdio:'ignore',windowsHide:true});
  else if(process.platform==='darwin') child=spawn('open',[url],{detached:true,stdio:'ignore'});
  else child=spawn('xdg-open',[url],{detached:true,stdio:'ignore'});
  child.unref();
}

app.post('/api/outlook/connect', (_req,res)=>{
  try{
    outlookIcsConfig();
    res.json({ok:true,configured:true,connected:true,pending:false,state:'connected',method:'ics-feed',message:'Published Outlook ICS feed is configured; no sign-in is required for calendar sync.'});
  }catch(e){res.status(400).json({configured:false,connected:false,state:'not-configured',method:'ics-feed',error:String(e.message||e)});}
});

app.get('/api/outlook/status', (_req,res)=>{
  try{
    outlookIcsConfig();
    res.json({configured:true,connected:true,pending:false,state:'connected',method:'ics-feed',syncedAt:outlookEventsCache.at||0});
  }catch(e){res.status(400).json({configured:false,connected:false,pending:false,state:'not-configured',method:'ics-feed',error:String(e.message||e)});}
});

// Creating an event opens Outlook Web's pre-filled compose page in the user's
// normal default browser. This deliberately reuses their ordinary Outlook Web
// login rather than maintaining a second hidden Chromium identity.
app.post('/api/outlook/events', express.json(), (req,res)=>{
  try{
    cleanupOutlookAutomationRequests();
    const body=req.body||{};
    const autoSave=body.autoSave!==false;
    const requestId=crypto.randomUUID();
    const composeUrl=buildOutlookComposeUrl(body,requestId);
    const u=new URL(composeUrl);
    const expectedQuery={};
    for(const key of ['browseros_request','subject','startdt','enddt','allday','location']){
      if(u.searchParams.has(key))expectedQuery[key]=u.searchParams.get(key);
    }
    const item={
      id:requestId,createdAt:Date.now(),updatedAt:Date.now(),expiresAt:Date.now()+5*60*1000,
      status:'pending',error:'',detail:'',autoSave,
      event:{
        subject:String(body.subject||body.title||'').trim(),start:String(body.start||'').trim(),end:String(body.end||'').trim(),
        location:String(body.location||'').trim(),allDay:!!(body.allDay||body.all_day)
      },
      expectedQuery
    };
    outlookAutomationRequests.set(requestId,item);
    openExternalUrl(composeUrl);
    const companion=companionIsConnected();
    const message=autoSave
      ? (companion
        ? 'Opened Outlook Web. BrowserOS Outlook Companion will verify the event and click Save automatically.'
        : 'Opened Outlook Web. Automatic Save was requested, but the BrowserOS Outlook Companion is not currently detected; save manually if it does not activate.')
      : 'Opened a pre-filled Outlook event in your normal browser. Review it and click Save.';
    res.json({
      ok:true,pendingUserSave:!autoSave,pendingAutomation:autoSave,automationRequestId:requestId,
      companionConnected:companion,method:'outlook-web-compose',message,composeUrl
    });
  }catch(e){res.status(400).json({error:String(e.message||e),method:'outlook-web-compose'});}
});

function editsRequireOutlookWeb(_req,res){
  let webUrl=DEFAULT_OUTLOOK_WEB_CALENDAR;
  try{webUrl=outlookIcsConfig().webCalendarUrl;}catch{}
  res.status(409).json({error:'Published ICS is read-only. Edit or delete this existing event in Outlook Web.',webUrl,method:'ics-feed'});
}
app.put('/api/outlook/events/:id', express.json(), editsRequireOutlookWeb);
app.post('/api/outlook/events/update', express.json(), editsRequireOutlookWeb);
app.post('/api/outlook/events/delete', express.json(), editsRequireOutlookWeb);

app.get('/api/outlook/events/cache', (_req,res)=>{
  const data=outlookEventsCache.data,local=readLocalCalendarEvents(),outlook=data?.events||[];
  return res.json({available:!!data||local.length>0,account:data?.account||'Outlook Web',events:mergeCalendarEvents(outlook),outlookCount:outlook.length,localCount:local.length,syncedAt:outlookEventsCache.at||0,ageMs:outlookEventsCache.at?Math.max(0,Date.now()-outlookEventsCache.at):null,method:'ics-plus-local-cache'});
});

app.get('/api/outlook/events', async (req,res)=>{
  const force=String(req.query.refresh||'')==='1',requestedStart=String(req.query.start||'').trim(),requestedEnd=String(req.query.end||'').trim(),now=Date.now(),cacheTtlMs=120*1000;
  const fromCache=!!(!force&&outlookEventsCache.data&&now-outlookEventsCache.at<cacheTtlMs);
  try{
    let data=fromCache?outlookEventsCache.data:null;if(!data){data=await fetchOutlookIcs();outlookEventsCache={at:Date.now(),data};}
    const outlookEvents=filterEvents(data.events||[],requestedStart,requestedEnd),localEvents=filterEvents(readLocalCalendarEvents(),requestedStart,requestedEnd);
    const events=[...outlookEvents,...localEvents].sort((a,b)=>String(a.start||'').localeCompare(String(b.start||'')));
    res.json({account:data.account||'Outlook Web',events,outlookCount:outlookEvents.length,localCount:localEvents.length,scanned:data.scanned||outlookEvents.length,cached:fromCache,syncedAt:outlookEventsCache.at,cacheTtlMs,method:'ics-plus-local'});
  }catch(e){
    const localEvents=filterEvents(readLocalCalendarEvents(),requestedStart,requestedEnd);
    if(outlookEventsCache.data){const outlookEvents=filterEvents(outlookEventsCache.data.events||[],requestedStart,requestedEnd),events=[...outlookEvents,...localEvents].sort((a,b)=>String(a.start||'').localeCompare(String(b.start||'')));return res.json({account:'Outlook Web',events,outlookCount:outlookEvents.length,localCount:localEvents.length,cached:true,stale:true,syncedAt:outlookEventsCache.at,cacheTtlMs,method:'ics-plus-local',warning:String(e.message||e)});}
    if(localEvents.length)return res.json({account:'BrowserOS local',events:localEvents,outlookCount:0,localCount:localEvents.length,cached:true,stale:true,syncedAt:0,cacheTtlMs,method:'local-only',warning:String(e.message||e)});
    res.status(502).json({error:String(e.message||e),method:'ics-feed'});
  }
});


// Scheduled Tasks execution -------------------------------------------------
async function composeScheduledText(systemPrompt,prompt,maxTokens=320){
  await ensureAgentStarted();
  const response=await fetch(`${agentUrl}/api/cron/compose`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({system_prompt:systemPrompt,prompt,max_tokens:maxTokens})});
  const data=await response.json().catch(()=>({error:`Tiny Web Agent returned HTTP ${response.status}`}));
  if(!response.ok||!data.ok)throw new Error(data.error||'Scheduled AI task failed.');return data;
}
async function runScheduledAgent(prompt,cfg={}){
  await ensureAgentStarted();
  const capabilityMode=['auto','skill','tools','none'].includes(String(cfg.capability_mode||''))?String(cfg.capability_mode):'auto';
  const body={
    prompt:String(prompt||''),
    capability_mode:capabilityMode,
    skill:capabilityMode==='skill'?String(cfg.skill_name||''):null,
    tools:capabilityMode==='tools'&&Array.isArray(cfg.tool_names)?cfg.tool_names:[],
    max_tool_calls:Math.max(0,Math.min(12,Number(cfg.max_tool_calls||6))),
    max_tokens:Math.max(128,Math.min(3000,Number(cfg.max_tokens||1600))),
  };
  const response=await fetch(`${agentUrl}/api/tasks/agent`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const data=await response.json().catch(()=>({error:`Tiny Web Agent returned HTTP ${response.status}`}));
  if(!response.ok||!data.ok)throw new Error(data.error||'Scheduled agent task failed.');
  return data;
}
function formatEventTime(event){if(event?.allDay||event?.all_day)return 'All day';const s=new Date(event?.start||'');if(Number.isNaN(s.getTime()))return 'Time unavailable';const f=d=>d.toLocaleTimeString([],{hour:'numeric',minute:'2-digit'}),e=new Date(event?.end||'');return !Number.isNaN(e.getTime())&&e>s?`${f(s)}–${f(e)}`:f(s)}
async function launchScheduledApp(query){const ranked=rankWindowsApps(String(query||'').trim(),await allWindowsApps(false),1),app=ranked[0];if(!app)throw new Error(`No installed app matched "${query}".`);if(app.source==='configured'){const cfg=readJson('config/apps.json').find(x=>String(x.id)===String(app.id));if(!cfg)throw new Error('Matched configured app is unavailable.');const child=spawn(cfg.command,Array.isArray(cfg.args)?cfg.args:[],{detached:true,stdio:'ignore',windowsHide:false});child.unref();}else{const child=spawn('explorer.exe',[`shell:AppsFolder\\${app.appId}`],{detached:true,stdio:'ignore',windowsHide:false});child.unref();}return app.name}
function scheduledCalendarRange(period){const now=new Date(),day=d=>{const x=new Date(d);x.setHours(0,0,0,0);return x};let start,end;if(period==='tomorrow'){start=day(new Date(now.getFullYear(),now.getMonth(),now.getDate()+1));end=new Date(start);end.setDate(end.getDate()+1);}else if(period==='next_7_days'){start=day(now);end=new Date(start);end.setDate(end.getDate()+7);}else{start=day(now);end=new Date(start);end.setDate(end.getDate()+1);}return{start:start.toISOString(),end:new Date(end.getTime()-1).toISOString()}}
async function executeCronJob(job,_runInfo){
  const cfg=job.config||{};const action=String(cfg.action_type||job.handler||(job.job_type==='agent_prompt'?'ai_task':'reminder'));
  if(action==='reminder'){const message=String(cfg.message||job.name||'Reminder').trim();if(!message)throw new Error('Reminder message is empty.');return{text:message,context_chars:0,meta:{kind:'reminder',inference_lane:'deterministic'}};}
  if(action==='launch_app'){const name=await launchScheduledApp(cfg.app_query||cfg.app_name||'');return{text:`Launched ${name}.`,context_chars:0,meta:{kind:'launch_app',app:name,inference_lane:'deterministic'}};}
  if(action==='calendar_check'){
    const period=['today','tomorrow','next_7_days'].includes(cfg.period)?cfg.period:'today',range=scheduledCalendarRange(period);let remote=[],warning='';
    try{const d=await fetchOutlookIcs();remote=d.events||[];outlookEventsCache={at:Date.now(),data:d};}catch(e){warning=String(e.message||e);remote=outlookEventsCache.data?.events||[];}
    const events=mergeCalendarEvents(remote,range.start,range.end),label=period==='today'?'Today':period==='tomorrow'?'Tomorrow':'Next 7 days';
    const lines=events.length?events.slice(0,30).map(e=>`${formatEventTime(e)} — ${e.subject||'Untitled'}${e.location?` @ ${e.location}`:''}${e.source==='browseros-local'?' [local]':''}`):['No calendar events found.'];
    const raw=`${label}: ${events.length} event${events.length===1?'':'s'}.\n${lines.join('\n')}${warning?`\nOutlook warning: ${warning}`:''}`;
    if(cfg.use_ai){const composed=await composeScheduledText('Summarize the supplied calendar facts concisely. NEVER invent events, times, locations, reminders, tasks, or missing facts. Use only the provided calendar lines.',raw.slice(0,4500),260);return{text:composed.response,context_chars:Number(composed.meta?.context_chars||0),meta:{kind:'calendar_check',event_count:events.length,model:composed.meta?.model||null,inference_lane:composed.meta?.inference_lane||'primary'}};}
    return{text:raw,context_chars:0,meta:{kind:'calendar_check',event_count:events.length,inference_lane:'deterministic'}};
  }
  if(action==='ai_task'){
    const prompt=String(cfg.instructions||job.prompt||'').trim();if(!prompt)throw new Error('AI task instructions are empty.');
    const scheduledPrompt=`Scheduled local time: ${new Date().toString()}\n\nTASK:\n${prompt.slice(0,5000)}`;
    const agent=await runScheduledAgent(scheduledPrompt,cfg);
    return{text:agent.response,context_chars:Number(agent.meta?.context_chars||0),meta:{kind:'ai_task',model:agent.meta?.model||null,inference_lane:agent.meta?.inference_lane||'primary_agent',capability_mode:agent.meta?.capability_mode||cfg.capability_mode||'auto',skill:agent.meta?.skill||null,tools:agent.meta?.tools||[],tool_calls:Number(agent.meta?.tool_calls||0),tool_traces:agent.meta?.tool_traces||[],finish_reason:agent.meta?.finish_reason||null,temporary_model:false}};
  }
  throw new Error(`Unsupported scheduled task action: ${action}`);
}
function cronApiReady(res){if(cronScheduler)return true;res.status(503).json({error:'Scheduled Tasks engine is not initialized.'});return false;}
function taskEventStream(req,res){res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive','X-Accel-Buffering':'no'});res.write(': BrowserOS Scheduled Tasks event stream\n\n');cronEventClients.add(res);const keep=setInterval(()=>{try{res.write(': ping\n\n')}catch{}},15000);req.on('close',()=>{clearInterval(keep);cronEventClients.delete(res)});}
app.get('/api/tasks/events',taskEventStream);app.get('/api/cron/events',taskEventStream);
function taskStatus(_req,res){if(!cronApiReady(res))return;res.json({ok:true,running:cronScheduler.running,db:cronScheduler.dbPath,timezone:Intl.DateTimeFormat().resolvedOptions().timeZone||'local',tasks:cronScheduler.listJobs().length});}
app.get('/api/tasks/status',taskStatus);app.get('/api/cron/status',taskStatus);
function listTasks(_req,res){if(!cronApiReady(res))return;const tasks=cronScheduler.listJobs();res.json({ok:true,tasks,jobs:tasks});}
app.get('/api/tasks',listTasks);app.get('/api/cron/jobs',listTasks);
function createTask(req,res){try{if(!cronApiReady(res))return;const task=cronScheduler.createJob(req.body||{});res.json({ok:true,task,job:task});}catch(e){res.status(400).json({error:e.message});}}
app.post('/api/tasks',createTask);app.post('/api/cron/jobs',createTask);
function updateTask(req,res){try{if(!cronApiReady(res))return;const task=cronScheduler.updateJob(req.params.id,req.body||{});res.json({ok:true,task,job:task});}catch(e){res.status(/not found/i.test(e.message)?404:400).json({error:e.message});}}
app.put('/api/tasks/:id',updateTask);app.put('/api/cron/jobs/:id',updateTask);
function deleteTask(req,res){try{if(!cronApiReady(res))return;const ok=cronScheduler.deleteJob(req.params.id);res.status(ok?200:404).json(ok?{ok:true}:{error:'Task not found.'});}catch(e){res.status(400).json({error:e.message});}}
app.delete('/api/tasks/:id',deleteTask);app.delete('/api/cron/jobs/:id',deleteTask);
function runTask(req,res){try{if(!cronApiReady(res))return;res.json({ok:true,...cronScheduler.runNow(req.params.id)});}catch(e){res.status(/not found/i.test(e.message)?404:400).json({error:e.message});}}
app.post('/api/tasks/:id/run',runTask);app.post('/api/cron/jobs/:id/run',runTask);
function listRuns(req,res){if(!cronApiReady(res))return;res.json({ok:true,runs:cronScheduler.listRuns({jobId:req.query.task_id||req.query.job_id||null,limit:req.query.limit||30})});}
app.get('/api/tasks/runs',listRuns);app.get('/api/cron/runs',listRuns);
app.post('/api/tasks/runs/:id/read',(req,res)=>{if(!cronApiReady(res))return;cronScheduler.markRunRead(req.params.id);res.json({ok:true});});
app.post('/api/cron/runs/:id/read',(req,res)=>{if(!cronApiReady(res))return;cronScheduler.markRunRead(req.params.id);res.json({ok:true});});
app.delete('/api/tasks/:id/runs',(req,res)=>{if(!cronApiReady(res))return;try{const cleared=cronScheduler.clearRuns(req.params.id);res.json({ok:true,cleared});}catch(e){res.status(404).json({error:String(e.message||e)});}});
app.delete('/api/cron/jobs/:id/runs',(req,res)=>{if(!cronApiReady(res))return;try{const cleared=cronScheduler.clearRuns(req.params.id);res.json({ok:true,cleared});}catch(e){res.status(404).json({error:String(e.message||e)});}});

app.post('/api/tasks/runs/:id/open-in-agent',express.json(),async(req,res)=>{
  try{
    if(!cronApiReady(res))return;
    const run=cronScheduler.getRun(req.params.id);
    if(!run) return res.status(404).json({error:'Task run not found.'});
    if(run.status!=='success'||!String(run.result||'').trim())return res.status(400).json({error:'Only completed task results can be opened in Tiny Web Agent.'});
    const job=cronScheduler.getJob(run.job_id);
    if(!job)return res.status(404).json({error:'Scheduled task not found.'});
    await ensureAgentStarted();

    let conversationId=String(run.meta?.agent_conversation_id||'').trim();
    if(conversationId){
      try{
        const check=await fetch(`${agentUrl}/api/conversations/${encodeURIComponent(conversationId)}`);
        if(!check.ok)conversationId='';
      }catch{conversationId='';}
    }

    if(!conversationId){
      const cfg=job.config||{};
      const taskText=String(cfg.instructions||job.prompt||cfg.message||job.name||'Scheduled task').trim();
      const imported=await fetch(`${agentUrl}/api/tasks/import-result`,{
        method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
          title:`Scheduled · ${job.name}`,task:taskText,result:run.result,tool_traces:Array.isArray(run.meta?.tool_traces)?run.meta.tool_traces:[]
        })
      });
      const data=await imported.json().catch(()=>({error:`Tiny Web Agent returned HTTP ${imported.status}`}));
      if(!imported.ok||!data.ok)throw new Error(data.error||'Could not create Tiny Web Agent conversation.');
      conversationId=String(data.conversation_id||'').trim();
      if(!conversationId)throw new Error('Tiny Web Agent did not return a conversation id.');
      cronScheduler.updateRunMeta(run.id,{agent_conversation_id:conversationId});
    }
    res.json({ok:true,conversation_id:conversationId,url:`${agentUrl}/?conversation=${encodeURIComponent(conversationId)}`});
  }catch(e){res.status(500).json({error:String(e.message||e)});}
});

cronScheduler=new CronScheduler({executor:executeCronJob,onEvent:emitCronEvent,maxSleepMs:60000});

app.get('*', (_req,res)=>res.sendFile(path.join(root,'index.html')));
server.on('error', error => { if (error && error.code === 'EADDRINUSE') { console.error(`\nERROR: Port ${port} is already in use. An older Browser-OS server is probably still running. Stop that old npm/node process before starting this build.\n`); process.exit(1); } throw error; });
server.listen(port,'127.0.0.1',()=>{console.log(`Browser-OS ${BUILD_ID} running at http://127.0.0.1:${port}`);cronScheduler?.start();console.log(`[Scheduled Tasks] active · ${cronScheduler?.listJobs().length||0} task(s) · ${cronScheduler?.dbPath||''}`);});
