// Preload factice : sert uniquement à prévisualiser l'interface (scripts/apercu.mjs).
const { contextBridge } = require('electron')

let listener = () => {}

const DOCUMENTS = [
  { nom: '2026-08-29-situation-economique-de-londres.md', titre: 'Situation économique de Londres', mots: 2480, sources: 9, version: 3, mis_a_jour_le: '2026-08-29' },
  { nom: '2026-08-21-marche-du-bois-construction.md', titre: 'Le marché du bois construction en France', mots: 1930, sources: 7, version: 1, mis_a_jour_le: '2026-08-21' },
]

const VERSIONS = [
  { numero: 3, courante: true, mots: 3120, sources: 11, date: '2026-08-29' },
  { numero: 2, courante: false, mots: 2480, sources: 9, date: '2026-08-29' },
  { numero: 1, courante: false, mots: 1740, sources: 6, date: '2026-08-29' },
]

const CONVERSATIONS = [
  { id: 'c1', titre: 'Situation économique de Londres — état des lieux, août 2026', maj_le: new Date().toISOString(), documents: 1, messages: 3, sansTitre: false, statut: 'en_cours' },
  { id: 'c2', titre: 'Le marché du bois construction en France', maj_le: new Date(Date.now() - 86400000).toISOString(), documents: 1, messages: 2, sansTitre: false, statut: 'incomplet' },
  { id: 'c3', titre: 'Nouvelle conversation', maj_le: new Date(Date.now() - 5 * 86400000).toISOString(), documents: 0, messages: 0, sansTitre: true },
]

contextBridge.exposeInMainWorld('redacteur', {
  init: async () => ({
    config: { model: 'claude-opus-5', profondeur: 'standard', langue: 'français', ouvrirAuto: true, barreVisible: true },
    bibliotheque: '/Users/demo/Assistant Rédacteur',
    documents: DOCUMENTS,
    conversations: CONVERSATIONS,
    version: '1.0.0',
  }),
  send: () => {},
  interrupt: () => {},
  setConfig: () => {},
  replyPermission: () => {},
  conv: {
    list: async (q) => (q ? CONVERSATIONS.filter((c) => c.titre.toLowerCase().includes(q.toLowerCase())) : CONVERSATIONS),
    create: async () => 'c9',
    open: async (id) => id,
    resume: async (id) => id,
    rename: async () => CONVERSATIONS,
    remove: async () => CONVERSATIONS,
  },

  docs: {
    list: async () => DOCUMENTS,
    sources: async () => [],
    open: () => {},
    reveal: () => {},
    remove: async () => DOCUMENTS,
    versions: async () => VERSIONS,
    openVersion: () => {},
    export: async () => ({ chemin: '/Users/demo/Downloads/doc.md' }),
  },
  choisirBibliotheque: async () => ({ bibliotheque: '/tmp', documents: DOCUMENTS }),
  openBibliotheque: () => {},
  openExternal: () => {},
  onEvent: (cb) => { listener = cb; return () => {} },
  _fire: (evt) => listener(evt),
})
