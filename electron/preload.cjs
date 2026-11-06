const { contextBridge, ipcRenderer } = require('electron');

const call = (channel, ...args) => ipcRenderer.invoke(channel, ...args).then((r) => {
  if (r && r.error) throw new Error(r.error);
  return r ? r.value : undefined;
});

contextBridge.exposeInMainWorld('desktop', {
  platform: process.platform,
  setTheme: (theme) => call('app:theme', theme),
  openExternal: (url) => call('app:open', url),
  onAuthToken: (cb) => ipcRenderer.on('auth-token', (_e, token, nonce) => cb(token, nonce)),
  pickFolder: () => call('ws:pick'),
  list: (root, dir) => call('ws:list', root, dir || ''),
  read: (root, rel) => call('ws:read', root, rel),
  write: (root, rel, content) => call('ws:write', root, rel, content),
  remove: (root, rel) => call('ws:remove', root, rel),
  exists: (root, rel) => call('ws:exists', root, rel),
  grep: (root, pattern, prefix) => call('ws:grep', root, pattern, prefix || ''),
  reveal: (root) => call('ws:reveal', root),
  run: (root, command, timeoutSec) => call('proc:run', root, command, timeoutSec),
  start: (root, command) => call('proc:start', root, command),
  output: (id) => call('proc:output', id),
  kill: (id) => call('proc:kill', id),
  killForeground: () => call('proc:killForeground'),
  processes: () => call('proc:list'),
});
