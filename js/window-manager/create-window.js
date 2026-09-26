// Browser-OS original window manager logic, restored from gultar/browser-os.
// Only the storage constructor is locally aliased so the original code can run
// without the obsolete filesystem/session layer.
const Storage = BrowserOSStorage

window.openWindows = {}
window.launchSequence = {}

const storage = new Storage({})

class ApplicationWindow extends WinBox{

constructor(opts){

if(!opts.width) opts.width = "500"
if(!opts.height) opts.height = "350"

// Adapt requested window dimensions to the current viewport before WinBox is created.
if(window.BrowserOSResponsive){
const responsive = BrowserOSResponsive.responsiveDefaults(opts.width, opts.height)
opts.width = responsive.width
opts.height = responsive.height
if(responsive.x !== undefined && opts.x === undefined) opts.x = responsive.x
if(responsive.y !== undefined && opts.y === undefined) opts.y = responsive.y
}

// Reserve the Browser-OS menu bar as a hard, non-traversable zone.
// WinBox uses these boundary options for dragging, maximizing and resizing,
// so windows can never move behind the top menu.
const topbar = document.getElementById("topnav")
const reservedTop = topbar ? Math.ceil(topbar.getBoundingClientRect().height) : 32
if(opts.top === undefined) opts.top = reservedTop
// Keep normal WinBox windows out from under the persistent right dock.
if(opts.right === undefined && window.BrowserOSDock) opts.right = window.BrowserOSResponsive ? BrowserOSResponsive.reservedRight() : BrowserOSDock.getReservedWidth()

// Old saved window positions may predate the reserved menu zone. Clamp them.
if(typeof opts.y === "number" && opts.y < reservedTop) opts.y = reservedTop
if(typeof opts.y === "string" && /^-?\d+(?:\.\d+)?(?:px)?$/.test(opts.y)){
const parsedY = parseFloat(opts.y)
if(parsedY < reservedTop) opts.y = reservedTop
}

super(opts)
this.name = opts.label || opts.title
this.launcher = opts.launcher || {}
saveState(this)
this.onclose = (callback=()=>{}) =>{

delete window.openWindows[this.name]
delete window.launchSequence[this.name]
if(opts.onclose) opts.onclose(callback)
}
this.onmove = (x, y) =>{

if(this.launcher && this.launcher.opts){
this.launcher.opts.x = x
this.launcher.opts.y = y
saveState(this)
}
}
window.openWindows[this.name] = this
if(window.BrowserOSResponsive) setTimeout(()=>BrowserOSResponsive.fitWindow(this),0)
}
destroy(callback){
delete window.openWindows[this.name]
}
}

const saveState = (winbox) =>{
window.launchSequence[winbox.name] = {
launcher:{
name:winbox.launcher.name,
opts:winbox.launcher.opts
}
}
}

const minimizeAllWindows = (force=false) =>{
for(const windowName in window.openWindows){
const instance = window.openWindows[windowName]
const state = (force?true:!instance.min)
if(instance && instance.minimize)
instance.minimize(state)
}
}

const restoreAllWindows = () =>{
for(const windowName in window.openWindows){
const instance = window.openWindows[windowName]
if(instance)
instance.restore(true)
}
}
const revertWindowStates = () =>{
}
const saveWindowState = () =>{
window.launchSequence = {}
for(const windowLabel in window.openWindows){
const instance = window.openWindows[windowLabel]
saveState(instance)
}
storage.set("launch-sequence", window.launchSequence)
}
const loadWindowState = async () =>{
const launchSequence = storage.get("launch-sequence")
console.log('launchSequence', launchSequence)
for(const windowLabel in launchSequence){
try{
const windowState = launchSequence[windowLabel]
console.log('Window state', windowState)
const { launcher, x, y } = windowState
const { params, opts } = launcher
const App = window[launcher.name]

// Tiny Web Agent hand-offs may contain a one-shot programmatic prompt. Older
// BrowserOS builds persisted those transient values inside launch-sequence.
// Strip them during restoration so an already-saved prompt cannot auto-resume
// after a crash or forced shutdown.
const restoredOpts = { ...(opts || {}) }
if(launcher.name === 'TinyAgentWindow'){
  delete restoredOpts.initialMessage
  delete restoredOpts.newConversation
  delete restoredOpts.skill
}
new App({ x:x, y:y, ...restoredOpts })
}catch(e){
console.log('Window Launcher Error', e)
}
}
}
const cycleThroughWindows = () =>{
let position = 0
let windowNames = []
$(window).keydown(function(event) {
if (event.ctrlKey && event.which == 9) { //CTRL + Tab
windowNames = Object.keys(window.openWindows)
console.log(Object.keys(window.openWindows))
minimizeAllWindows("force")
if(windowNames.length > 0){
const windowName = windowNames[position]
const openWindow = window.openWindows[windowName]
if(openWindow) openWindow.minimize(false)
position++
if(position >= windowNames.length) position = 0
}
}
});
}

window.ApplicationWindow = ApplicationWindow
window.minimizeAllWindows = minimizeAllWindows
window.restoreAllWindows = restoreAllWindows
window.revertWindowStates = revertWindowStates
window.saveWindowState = saveWindowState
window.loadWindowState = loadWindowState
window.cycleThroughWindows = cycleThroughWindows
