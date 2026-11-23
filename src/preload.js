'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (fn) => {
  const h = (_e, ...args) => fn(...args);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
};

contextBridge.exposeInMainWorld('hd', {
  state: () => ipcRenderer.invoke('state:get'),
  agents: () => ipcRenderer.invoke('agents:list'),
  createAgent: (input) => ipcRenderer.invoke('agent:create', input),
  startAgent: (id) => ipcRenderer.invoke('agent:start', id),
  freshAgent: (id) => ipcRenderer.invoke('agent:fresh', id),
  stopAgent: (id) => ipcRenderer.invoke('agent:stop', id),
  removeAgent: (id) => ipcRenderer.invoke('agent:remove', id),
  typeTo: (id, text) => ipcRenderer.invoke('agent:type', id, text),
  write: (id, data) => ipcRenderer.send('pty:write', id, data),
  resize: (id, cols, rows) => ipcRenderer.send('pty:resize', id, cols, rows),
  replay: (id) => ipcRenderer.invoke('pty:replay', id),
  sendMessage: (msg) => ipcRenderer.invoke('hive:send', msg),
  tasks: () => ipcRenderer.invoke('hive:tasks'),
  saveTasks: (t) => ipcRenderer.invoke('hive:saveTasks', t),
  board: () => ipcRenderer.invoke('hive:board'),
  saveBoard: (t) => ipcRenderer.invoke('hive:saveBoard', t),
  log: (n) => ipcRenderer.invoke('hive:log', n),
  memory: (id) => ipcRenderer.invoke('hive:memory', id),
  searchMemory: (q) => ipcRenderer.invoke('hive:searchMemory', q),
  human: () => ipcRenderer.invoke('hive:human'),
  humanDone: (file) => ipcRenderer.invoke('hive:humanDone', file),
  openPath: (p) => ipcRenderer.invoke('open:path', p),
  pickFolder: () => ipcRenderer.invoke('pick:folder'),
  saveSettings: (s) => ipcRenderer.invoke('settings:save', s),
  onData: on('pty:data'),
  onStatus: on('agent:status'),
  onTool: on('agent:tool'),
  onMessage: on('hive:message'),
  onLog: on('hive:log'),
  onHuman: on('human:new'),
  onAgentsChanged: on('agents:changed'),
});
