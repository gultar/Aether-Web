const activeTerminals = []
window.activeTerminals = {}
class TerminalWindow{
constructor(opts={}){
const { x, y } = opts
this.x = x
this.y = y
this.terminalId = Date.now() + Math.floor(Math.random() * 1000)
this.term = ""
this.terminalDOM = ""
this.init()
}
async init(){
await this.injectDOM()
this.terminalDOM = document.getElementById("terminal-window-"+this.terminalId)
this.terminalDOM.style.visibility = "visible"
this.term = new Terminal(this.terminalId);
this.term.init();
this.termWindow = new ApplicationWindow({
x:this.x,
y:this.y,
label:"terminal-window-"+this.terminalId,
launcher:{
name:"TerminalWindow",
opts:{ x:this.x, y:this.y }
},
title: "",
mount: this.terminalDOM,
onclose:()=>{
this.terminalDOM.remove();
this.term = null
delete window.activeTerminals[this.terminalId]
},
});
if(window.BrowserOSDock){
this.termWindow.addControl({
index: 0,
class: "wb-dock",
image: "./images/dock.svg",
click: function(event, winbox){
BrowserOSDock.dock("terminal")
winbox.close()
}
})
}
this.termWindow.addControl({
index: 1,
class: "wb-panels",
image: "./images/panels.svg",
click: function(event, winbox){
if(!winbox.isSplitscreen){
winbox.isSplitscreen = true
winbox.resize("50%","100%")
}else{
winbox.resize("50%","50%")
winbox.isSplitscreen = false
}
}
})
this.terminalDOM.style.height = "100%"
this.terminalDOM.style.width = "100%"
}
async injectDOM(){
const domElement = `
<div id="terminal-window-${this.terminalId}" class="terminal-window" style="">
<div id="container-${this.terminalId}" class="container">
<output id="output-${this.terminalId}" class="output"></output>
<div action="#" id="input-line-${this.terminalId}" class="input-line">
<div id="prompt-${this.terminalId}" class="prompt"></div>
<div class="terminal-command-wrap"><input tabindex="0" id="cmdline-${this.terminalId}" class="cmdline" autofocus /></div>
</div>
</div>
</div>`
const parentNode = $("#main-container")
parentNode.append(domElement)
window.activeTerminals[this.terminalId] = this.term
return true
}
}
window.TerminalWindow = TerminalWindow
