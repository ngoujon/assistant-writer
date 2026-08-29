const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('redacteur', {
  init: () => ipcRenderer.invoke('app:init'),
  send: (text) => ipcRenderer.send('chat:send', text),
  interrupt: () => ipcRenderer.send('chat:interrupt'),
  setConfig: (patch) => ipcRenderer.send('chat:config', patch),
  replyPermission: (id, answer) => ipcRenderer.send('perm:reply', { id, answer }),

  conv: {
    list: (recherche) => ipcRenderer.invoke('conv:list', recherche),
    create: () => ipcRenderer.invoke('conv:new'),
    open: (id) => ipcRenderer.invoke('conv:open', id),
    resume: (id) => ipcRenderer.invoke('conv:resume', id),
    rename: (id, titre) => ipcRenderer.invoke('conv:rename', { id, titre }),
    remove: (id) => ipcRenderer.invoke('conv:delete', id),
  },

  docs: {
    list: () => ipcRenderer.invoke('docs:list'),
    sources: () => ipcRenderer.invoke('docs:sources'),
    open: (nom) => ipcRenderer.send('docs:open', nom),
    reveal: (nom) => ipcRenderer.send('docs:reveal', nom),
    remove: (nom) => ipcRenderer.invoke('docs:delete', nom),
    versions: (nom) => ipcRenderer.invoke('docs:versions', nom),
    openVersion: (nom, numero) => ipcRenderer.send('docs:open-version', { nom, numero }),
    export: (nom, numero) => ipcRenderer.invoke('docs:export', { nom, numero }),
  },

  choisirBibliotheque: () => ipcRenderer.invoke('app:choisir-bibliotheque'),
  openBibliotheque: () => ipcRenderer.send('app:open-bibliotheque'),
  openExternal: (url) => ipcRenderer.send('app:open-external', url),

  onEvent: (cb) => {
    const handler = (_e, evt) => cb(evt)
    ipcRenderer.on('agent', handler)
    return () => ipcRenderer.removeListener('agent', handler)
  },
})
