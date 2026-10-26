import type { IpcRendererEvent } from 'electron'

// Un preload sandboxé est du CommonJS : `require`, pas `import`.
const { contextBridge, ipcRenderer } = require('electron') as typeof import('electron')

contextBridge.exposeInMainWorld('redacteur', {
  init: () => ipcRenderer.invoke('app:init'),
  send: (text: string) => ipcRenderer.send('chat:send', text),
  interrupt: () => ipcRenderer.send('chat:interrupt'),
  setConfig: (patch: Record<string, unknown>) => ipcRenderer.send('chat:config', patch),
  replyPermission: (id: string, answer: unknown) => ipcRenderer.send('perm:reply', { id, answer }),

  conv: {
    list: (recherche?: string) => ipcRenderer.invoke('conv:list', recherche),
    create: () => ipcRenderer.invoke('conv:new'),
    open: (id: string) => ipcRenderer.invoke('conv:open', id),
    resume: (id?: string) => ipcRenderer.invoke('conv:resume', id),
    rename: (id: string, titre: string) => ipcRenderer.invoke('conv:rename', { id, titre }),
    remove: (id: string) => ipcRenderer.invoke('conv:delete', id),
  },

  docs: {
    list: () => ipcRenderer.invoke('docs:list'),
    sources: () => ipcRenderer.invoke('docs:sources'),
    open: (nom: string) => ipcRenderer.send('docs:open', nom),
    reveal: (nom: string) => ipcRenderer.send('docs:reveal', nom),
    remove: (nom: string) => ipcRenderer.invoke('docs:delete', nom),
    versions: (nom: string) => ipcRenderer.invoke('docs:versions', nom),
    openVersion: (nom: string, numero: number) => ipcRenderer.send('docs:open-version', { nom, numero }),
    export: (nom: string, numero?: number) => ipcRenderer.invoke('docs:export', { nom, numero }),
  },

  choisirBibliotheque: () => ipcRenderer.invoke('app:choisir-bibliotheque'),
  openBibliotheque: () => ipcRenderer.send('app:open-bibliotheque'),
  openExternal: (url: string) => ipcRenderer.send('app:open-external', url),

  onEvent: (cb: (evt: unknown) => void) => {
    const handler = (_e: IpcRendererEvent, evt: unknown) => cb(evt)
    ipcRenderer.on('agent', handler)
    return () => ipcRenderer.removeListener('agent', handler)
  },
})
