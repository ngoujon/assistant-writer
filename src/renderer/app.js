import { renderMarkdown } from './markdown.js'

const api = window.redacteur
const thread = document.getElementById('thread')
const scroll = document.getElementById('scroll')
const input = document.getElementById('input')
const sendBtn = document.getElementById('btn-send')
const statusLine = document.getElementById('status-line')
const panneauReglages = document.getElementById('settings')
const modelSelect = document.getElementById('model')
const profondeurSelect = document.getElementById('profondeur')
const langueSelect = document.getElementById('langue')
const autonomieSelect = document.getElementById('autonomie')
const listeDocs = document.getElementById('liste-docs')
const cheminBiblio = document.getElementById('chemin-biblio')
const barre = document.getElementById('barre')
const recherche = document.getElementById('recherche')
const listeConv = document.getElementById('liste-conv')
const docsBarre = document.getElementById('docs-barre')

let busy = false
let currentText = null
let currentThinking = null
let currentSources = null
let toolEls = new Map()
let documents = []
let conversations = []
let convCourante = null
let bibliotheque = ''
let porteeDocs = 'conversation'
/** Le total de la bibliothèque : la colonne, elle, ne montre qu'un fil à la fois. */
let totalDocs = 0
const permsEnAttente = []
/** Messages écrits pendant qu'il travaillait, pas encore repris par l'agent. */
let enFile = []

// ------------------------------------------------------------------ outils

const el = (tag, cls, text) => {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text != null) n.textContent = text
  return n
}

const nearBottom = () => scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 90
let stick = true
scroll.addEventListener('scroll', () => { stick = nearBottom() })

function scrollDown(force) {
  if (force) stick = true
  if (stick) scroll.scrollTop = scroll.scrollHeight
}

function add(node) {
  thread.appendChild(node)
  scrollDown()
  return node
}

// ------------------------------------------------------------------ accueil

const SUGGESTIONS = [
  'Fais-moi un rapport complet sur la situation économique de Londres',
  "Où en est la réglementation européenne sur l'IA ?",
  'Note de synthèse : le marché du bois construction en France',
  'Analyse ce que dit cette page : https://',
]

function showWelcome() {
  const box = el('div', 'welcome')
  const h = new Date().getHours()
  const salut = h < 5 ? 'Bonne nuit' : h < 12 ? 'Bonjour' : h < 18 ? 'Bon après-midi' : 'Bonsoir'
  box.appendChild(el('h1', null, `${salut} Nicolas 👋`))
  box.appendChild(el('p', null, documents.length
    ? `${documents.length} document${documents.length > 1 ? 's' : ''} dans ta bibliothèque. Donne-moi un sujet ou une adresse : je me renseigne et je te rédige un document sourcé.`
    : 'Donne-moi un sujet ou une adresse web : je cherche, je lis les sources, et je te rédige un document Markdown détaillé et sourcé.'))
  const chips = el('div', 'chips')
  for (const s of SUGGESTIONS) {
    const c = el('button', 'chip', s)
    // Une suggestion inachevée (une adresse à coller) se pose dans le champ.
    c.addEventListener('click', () => {
      if (s.endsWith('https://')) {
        input.value = s
        input.focus()
        autoGrow()
        majBouton()
      } else submit(s)
    })
    chips.appendChild(c)
  }
  box.appendChild(chips)
  thread.appendChild(box)
}

function dropWelcome() {
  thread.querySelector('.welcome')?.remove()
}

// ---------------------------------------------------------- noms des outils

const OUTILS = {
  consulter_source: ['🔍', 'Lire une source'],
  sources_consultees: ['🗂', 'Registre des sources'],
  relire_source: ['📑', 'Relire une source'],
  rediger_document: ['📝', 'Rédiger le document'],
  lister_documents: ['📚', 'Parcourir la bibliothèque'],
  lire_document: ['📄', 'Relire un document'],
  ouvrir_document: ['↗', 'Ouvrir un document'],
  supprimer_document: ['🗑', 'Supprimer un document'],
}

const BUILTIN = {
  Bash: ['⌘', 'Terminal'],
  Read: ['📄', 'Lire un fichier'],
  Write: ['✏️', 'Écrire un fichier'],
  Edit: ['✏️', 'Modifier un fichier'],
  Glob: ['🔎', 'Chercher des fichiers'],
  Grep: ['🔎', 'Chercher dans les fichiers'],
  WebSearch: ['🌐', 'Recherche web'],
  TodoWrite: ['📋', 'Plan de travail'],
  Task: ['🤖', 'Sous-agent'],
}

function describeTool(name) {
  if (name.startsWith('mcp__redacteur__')) {
    const court = name.slice('mcp__redacteur__'.length)
    return OUTILS[court] || ['📝', court.replace(/_/g, ' ')]
  }
  if (BUILTIN[name]) return BUILTIN[name]
  if (name.startsWith('mcp__')) return ['🔌', name.split('__').slice(1).join(' · ')]
  return ['•', name]
}

function summarizeInput(name, input) {
  if (!input || typeof input !== 'object') return ''
  if (name === 'Bash') return String(input.command || '')
  if (name.endsWith('rediger_document')) return String(input.titre || '')
  if (input.file_path) return String(input.file_path).split('/').pop()
  for (const k of ['url', 'query', 'nom', 'id', 'titre', 'prompt', 'description', 'pattern']) {
    if (typeof input[k] === 'string' && input[k]) return input[k]
  }
  const first = Object.values(input).find((v) => typeof v === 'string' && v)
  return first ? String(first) : ''
}

const MONO_TOOLS = new Set(['Bash', 'Write', 'Edit'])

const ETIQUETTES = {
  url: 'adresse', titre: 'titre', sujet: 'sujet', nom: 'fichier', sources: 'sources',
  markdown: 'document', remplacer: 'réécrire', sans_source: 'sans source',
  command: 'commande', file_path: 'fichier', query: 'recherche', id: 'source',
  contient: 'contient', relire: 'relire',
}

function humanizeInput(value, depth = 0, lines = []) {
  if (lines.length > 18) return lines
  if (Array.isArray(value)) {
    value.slice(0, 8).forEach((item) => lines.push(`${'  '.repeat(depth)}• ${item}`))
    if (value.length > 8) lines.push(`${'  '.repeat(depth)}… +${value.length - 8}`)
    return lines
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (v == null || v === '') continue
      const label = ETIQUETTES[k] || k
      if (typeof v === 'object') {
        lines.push(`${'  '.repeat(depth)}${label} :`)
        humanizeInput(v, depth + 1, lines)
      } else {
        const s = String(v)
        lines.push(`${'  '.repeat(depth)}${label} : ${s.length > 220 ? `${s.slice(0, 220)}…` : s}`)
      }
    }
    return lines
  }
  lines.push(`${'  '.repeat(depth)}${value}`)
  return lines
}

// -------------------------------------------------------------------- rendu

function pushUserMessage(text, enAttente) {
  dropWelcome()
  const node = el('div', `msg user${enAttente ? ' enfile' : ''}`, text)
  if (enAttente) {
    node.appendChild(el('span', 'attente', 'pris en compte à la prochaine étape'))
    enFile.push(node)
  }
  add(node)
  scrollDown(true)
}

/**
 * L'agent vient de reprendre la parole ou d'appeler un outil : le SDK lui a donc
 * remis les messages en attente à cette respiration-là. On retire le marqueur.
 */
function videEnFile() {
  for (const n of enFile.splice(0, enFile.length)) {
    n.classList.remove('enfile')
    n.querySelector('.attente')?.remove()
  }
}

function startTextBlock() {
  dropWelcome()
  videEnFile()
  finishThinking()
  currentSources = null
  const node = el('div', 'msg assistant md')
  currentText = { el: node, raw: '' }
  add(node)
}

let renderQueued = false
function appendText(chunk) {
  if (!currentText) startTextBlock()
  currentText.raw += chunk
  if (renderQueued) return
  renderQueued = true
  requestAnimationFrame(() => {
    renderQueued = false
    if (!currentText) return
    currentText.el.innerHTML = renderMarkdown(currentText.raw)
    scrollDown()
  })
}

function finishText() {
  if (currentText) {
    currentText.el.innerHTML = renderMarkdown(currentText.raw)
    if (!currentText.raw.trim()) currentText.el.remove()
  }
  currentText = null
}

function startThinking() {
  finishText()
  if (currentThinking) return
  const node = el('div', 'msg thinking')
  currentThinking = { el: node, raw: '' }
  add(node)
}

function appendThinking(chunk) {
  if (!currentThinking) startThinking()
  currentThinking.raw += chunk
  currentThinking.el.textContent = currentThinking.raw
  currentThinking.el.scrollTop = currentThinking.el.scrollHeight
  scrollDown()
}

function finishThinking() {
  if (currentThinking) currentThinking.el.classList.add('done')
  currentThinking = null
}

function addTool(evt) {
  videEnFile()
  finishText()
  finishThinking()
  // Les sources lues s'affichent comme des puces, pas comme des appels d'outil :
  // c'est la matière du document, pas de la plomberie.
  if (evt.name === 'mcp__redacteur__consulter_source') return
  currentSources = null
  const node = noeudOutil(evt.name, summarizeInput(evt.name, evt.input), humanizeInput(evt.input).join('\n'))
  node.classList.add('running')
  toolEls.set(evt.id, node)
  add(node)
}

/** La ligne d'un appel d'outil. Sert aussi à rejouer un fil enregistré. */
function noeudOutil(nom, arg, detail) {
  const [glyph, label] = describeTool(nom)
  const node = el('div', 'msg tool')
  const head = el('div', 'head')
  head.appendChild(el('span', 'glyph', glyph))
  head.appendChild(el('span', 'label', label))
  if (arg) head.appendChild(el('span', 'arg', arg))
  head.appendChild(el('span', 'state'))
  node.appendChild(head)
  const body = el('div', 'body')
  body.textContent = detail || ''
  node.appendChild(body)
  head.addEventListener('click', () => node.classList.toggle('open'))
  return node
}

function endTool(evt) {
  const node = toolEls.get(evt.id)
  if (!node) return
  node.classList.remove('running')
  node.classList.add(evt.ok ? 'ok' : 'err')
  const body = node.querySelector('.body')
  if (evt.preview) body.textContent = `${body.textContent}\n\n— — —\n${evt.preview}`
  if (!evt.ok) node.classList.add('open')
}

/**
 * Un tour s'est arrêté en route. Plutôt qu'un message d'erreur, on offre la
 * reprise : l'application rebranche la session sur son contexte et redemande la
 * suite. C'est la seule chose à faire, autant la mettre à un clic.
 */
function proposerReprise(texte) {
  thread.querySelector('.reprise')?.remove()
  const box = el('div', 'reprise')
  const bouton = el('button', 'chip', texte || '↻ Reprendre où tu t\'es arrêté')
  bouton.addEventListener('click', async () => {
    box.remove()
    setBusy(true)
    await api.conv.resume(convCourante)
  })
  box.appendChild(bouton)
  add(box)
  scrollDown(true)
}

function addNote(text, kind) {
  finishText()
  add(el('div', `note${kind ? ` ${kind}` : ''}`, text))
}

// ------------------------------------------------------- sources consultées

function puceSource(s, dejaLue) {
  const puce = el('div', 'puce-source')
  puce.appendChild(el('span', 'n', s.id))
  puce.appendChild(el('span', 't', s.titre || s.url))
  const hote = (() => { try { return new URL(s.url).hostname.replace(/^www\./, '') } catch { return '' } })()
  if (hote) puce.appendChild(el('span', 'h', hote))
  puce.title = `${s.url}${dejaLue ? '\n(déjà lue, texte conservé)' : ''}`
  puce.addEventListener('click', () => api.openExternal(s.url))
  return puce
}

function addSource(evt) {
  finishText()
  finishThinking()
  videEnFile()
  if (!currentSources) currentSources = add(el('div', 'sources-lues'))
  currentSources.appendChild(puceSource(evt.source, evt.deja_lue))
  scrollDown()
}

// -------------------------------------------------------- document produit

function carteDocument(d) {
  const version = Number(d.version || 1)
  const carte = el('div', 'doc-carte')
  const entete = el('div', 'entete')
  entete.appendChild(el('span', 'glyph', version > 1 ? '♻️' : '📝'))
  entete.appendChild(el('div', 't', d.titre))
  if (version > 1) entete.appendChild(el('span', 'v', `v${version}`))
  carte.appendChild(entete)
  carte.appendChild(el('div', 'm', [
    `${(d.mots || 0).toLocaleString('fr-FR')} mots`,
    `${d.sources_citees || 0} source${(d.sources_citees || 0) > 1 ? 's' : ''}`,
    version > 1 ? `version ${version}` : 'nouveau document',
  ].join(' · ')))
  // Ni bouton ni chemin de fichier ici : le document s'ouvre depuis la colonne
  // de droite, où toutes ses versions sont réunies au même endroit.
  const vers = el('button', 'vers-doc', '→ dans les documents, à droite')
  vers.addEventListener('click', () => {
    docsVisible(true)
    surlignerDocument(d.nom)
  })
  carte.appendChild(vers)
  return carte
}

function addDocument(evt) {
  finishText()
  finishThinking()
  currentSources = null
  add(carteDocument(evt.document))
  scrollDown(true)
}

// ------------------------------------------- largeur des colonnes latérales
//
// Une colonne trop étroite pour lire un titre, ou trop large pour laisser
// respirer le fil, ça dépend du moment et du sujet. On la tire à la main, et la
// largeur choisie est retenue.

const LARGEUR_MIN = 170

function appliquerLargeur(colonne, px) {
  if (px) colonne.style.flex = `0 0 ${px}px`
  else colonne.style.flex = ''
}

function poser(poignee, colonne, cote, cle) {
  poignee.addEventListener('pointerdown', (e) => {
    e.preventDefault()
    poignee.setPointerCapture(e.pointerId)
    poignee.classList.add('glisse')
    document.body.classList.add('redimensionne')
    const depart = e.clientX
    const initiale = colonne.offsetWidth
    let derniere = initiale

    const bouge = (ev) => {
      const delta = cote === 'gauche' ? ev.clientX - depart : depart - ev.clientX
      // On garde toujours de quoi lire le fil : au moins un quart de la fenêtre.
      const max = Math.max(LARGEUR_MIN, Math.round(window.innerWidth * 0.45))
      derniere = Math.min(max, Math.max(LARGEUR_MIN, initiale + delta))
      appliquerLargeur(colonne, derniere)
    }
    const fin = () => {
      poignee.removeEventListener('pointermove', bouge)
      poignee.removeEventListener('pointerup', fin)
      poignee.classList.remove('glisse')
      document.body.classList.remove('redimensionne')
      api.setConfig({ [cle]: derniere })
    }
    poignee.addEventListener('pointermove', bouge)
    poignee.addEventListener('pointerup', fin)
  })

  // Double-clic : retour au tiers de fenêtre.
  poignee.addEventListener('dblclick', () => {
    appliquerLargeur(colonne, null)
    api.setConfig({ [cle]: null })
  })
}

poser(document.getElementById('poignee-barre'), barre, 'gauche', 'largeurBarre')
poser(document.getElementById('poignee-docs'), docsBarre, 'droite', 'largeurDocs')

// ---------------------------------------------------- colonne des documents

async function changerPortee(portee) {
  porteeDocs = portee
  document.getElementById('portee-conv').classList.toggle('actif', portee === 'conversation')
  document.getElementById('portee-tous').classList.toggle('actif', portee === 'tous')
  api.setConfig({ porteeDocs: portee })
  documents = await api.docs.list(portee)
  renderDocuments()
}

document.getElementById('portee-conv').addEventListener('click', () => changerPortee('conversation'))
document.getElementById('portee-tous').addEventListener('click', () => changerPortee('tous'))

function docsVisible(v) {
  document.body.classList.toggle('docs-cachee', !v)
  api.setConfig({ docsVisible: v })
}

function surlignerDocument(nom) {
  const fiche = listeDocs.querySelector(`[data-nom="${CSS.escape(nom)}"]`)
  if (!fiche) return
  fiche.scrollIntoView({ block: 'nearest' })
  fiche.classList.add('recent')
}

/** Les versions d'un document, la plus récente en tête. */
async function remplirVersions(hote, nom) {
  hote.replaceChildren(el('div', 'vide', 'Chargement…'))
  const versions = await api.docs.versions(nom)
  hote.replaceChildren()
  for (const v of versions) {
    const ligne = el('div', `vligne${v.courante ? ' courante' : ''}`)
    ligne.appendChild(el('span', 'vn', v.courante ? `v${v.numero} · en place` : `v${v.numero}`))
    const meta = el('span', 'vd', `${v.mots.toLocaleString('fr-FR')} mots`)
    meta.title = `${v.date} · ${v.sources} source${v.sources > 1 ? 's' : ''}`
    ligne.appendChild(meta)
    const ouvrir = el('button', null, 'Ouvrir')
    ouvrir.addEventListener('click', () => (v.courante ? api.docs.open(nom) : api.docs.openVersion(nom, v.numero)))
    const exporter = el('button', null, 'Exporter')
    exporter.title = 'Enregistrer une copie de cette version'
    exporter.addEventListener('click', () => api.docs.export(nom, v.courante ? undefined : v.numero))
    ligne.append(ouvrir, exporter)
    hote.appendChild(ligne)
  }
}

function ficheDocument(d) {
  const fiche = el('div', 'doc-fiche')
  fiche.dataset.nom = d.nom
  fiche.appendChild(el('div', 't', d.titre))

  const meta = el('div', 'm')
  if (d.version > 1) meta.appendChild(el('span', 'v', `version ${d.version}`))
  meta.appendChild(el('span', null, d.mis_a_jour_le))
  meta.appendChild(el('span', null, `${d.mots.toLocaleString('fr-FR')} mots`))
  meta.appendChild(el('span', null, `${d.sources} source${d.sources > 1 ? 's' : ''}`))
  fiche.appendChild(meta)

  // Des mots, pas des symboles : on doit savoir ce qu'on clique sans deviner.
  const actions = el('div', 'actions-doc')
  const ouvrir = el('button', 'primary', 'Ouvrir')
  ouvrir.title = `Ouvrir ${d.nom} dans ton éditeur Markdown`
  ouvrir.addEventListener('click', () => api.docs.open(d.nom))
  const exporter = el('button', null, 'Exporter…')
  exporter.title = 'Enregistrer une copie ailleurs'
  exporter.addEventListener('click', () => api.docs.export(d.nom))
  actions.append(ouvrir, exporter)
  fiche.appendChild(actions)

  const liens = el('div', 'liens-doc')
  const finder = el('button', 'lien', 'Dans le Finder')
  finder.addEventListener('click', () => api.docs.reveal(d.nom))
  const sup = el('button', 'lien danger', 'Supprimer')
  sup.addEventListener('click', async () => {
    documents = await api.docs.remove(d.nom)
    renderDocuments()
  })
  liens.append(finder, sup)

  if (d.version > 1) {
    const vlist = el('div', 'vlist hidden')
    const plier = el('button', 'lien plier', `${d.version} versions ▾`)
    plier.title = 'Voir les versions précédentes'
    plier.addEventListener('click', () => {
      const ouverte = !vlist.classList.toggle('hidden')
      plier.textContent = `${d.version} versions ${ouverte ? '▴' : '▾'}`
      if (ouverte && !vlist.childElementCount) remplirVersions(vlist, d.nom)
    })
    liens.appendChild(plier)
    fiche.append(liens, vlist)
  } else {
    fiche.appendChild(liens)
  }
  return fiche
}

// --------------------------------------------------------------- permissions

function addPermission(evt) {
  finishText()
  finishThinking()
  currentSources = null
  const [glyph, label] = describeTool(evt.toolName)
  const card = el('div', `msg perm${evt.summary?.danger ? ' danger' : ''}`)
  if (evt.origine) card.appendChild(el('div', 'origine', `Demandé par « ${evt.origine} »`))
  card.appendChild(el('div', 't', evt.title || `${glyph} ${label} ?`))
  const sub = evt.subtitle || evt.reason
  if (sub) card.appendChild(el('div', 's', sub))
  if (evt.hint) card.appendChild(el('div', 's warn', evt.hint))

  const lignes = evt.summary?.lines || []
  if (lignes.length) {
    const mono = MONO_TOOLS.has(evt.toolName)
    const box = el('div', 'summary')
    for (const ligne of lignes) {
      const [tete, ...reste] = String(ligne).split('\n')
      const item = el('div', mono ? 'sline mono' : 'sline')
      item.appendChild(el('span', 'head', tete))
      if (reste.length) item.appendChild(el('span', 'meta', reste.join(' ')))
      box.appendChild(item)
    }
    card.appendChild(box)
    const brut = humanizeInput(evt.input).join('\n')
    if (brut) {
      const pre = el('pre', 'hidden', brut)
      const toggle = el('button', 'detail-toggle', 'Voir le détail technique')
      toggle.addEventListener('click', () => {
        const cache = pre.classList.toggle('hidden')
        toggle.textContent = cache ? 'Voir le détail technique' : 'Masquer le détail'
      })
      card.append(toggle, pre)
    }
  } else {
    const detail = evt.toolName === 'Bash' ? String(evt.input?.command || '') : humanizeInput(evt.input).join('\n')
    if (detail) card.appendChild(el('pre', null, detail))
  }

  const btns = el('div', 'btns')
  const entree = { id: evt.id }
  const repondre = (a) => {
    if (!permsEnAttente.includes(entree)) return
    permsEnAttente.splice(permsEnAttente.indexOf(entree), 1)
    api.replyPermission(evt.id, a)
    card.classList.add('answered')
    card.classList.remove('active')
    card.appendChild(el('div', 's', a.behavior === 'allow' ? (a.always ? '✓ Toujours autorisé' : '✓ Autorisé') : '✕ Refusé'))
    refreshActivePerm()
    input.focus()
  }
  entree.allow = () => repondre({ behavior: 'allow' })
  entree.deny = () => repondre({ behavior: 'deny', message: 'Refusé par Nicolas.' })
  entree.card = card
  permsEnAttente.push(entree)

  const oui = el('button', 'primary')
  oui.append(document.createTextNode('Autoriser'), el('kbd', null, '↩'))
  oui.addEventListener('click', () => entree.allow())
  const non = el('button', null)
  non.append(document.createTextNode('Refuser'), el('kbd', null, 'esc'))
  non.addEventListener('click', () => entree.deny())

  if (evt.allowAlways) {
    const toujours = el('button', null, 'Toujours')
    toujours.addEventListener('click', () => repondre({ behavior: 'allow', always: true }))
    btns.append(oui, toujours, non)
  } else {
    btns.append(oui, non)
  }
  card.appendChild(btns)
  card.appendChild(el('div', 'kb-hint', 'Champ vide : ↩ autorise, esc refuse.'))
  add(card)
  refreshActivePerm()
  scrollDown(true)
}

function refreshActivePerm() {
  for (const p of permsEnAttente) p.card.classList.remove('active')
  permsEnAttente[0]?.card.classList.add('active')
}

// --------------------------------------------------------------------- état

function setBusy(v) {
  busy = v
  document.body.classList.toggle('busy', v)
  sendBtn.disabled = !v && !input.value.trim()
}

function setStatus(text, kind) {
  statusLine.replaceChildren(el('span', `dot ${kind || ''}`), document.createTextNode(text))
}

function statusBibliotheque() {
  setStatus(totalDocs
    ? `${totalDocs} document${totalDocs > 1 ? 's' : ''} en bibliothèque`
    : 'Bibliothèque vide', 'ok')
}

// -------------------------------------------------------------------- envoi

/**
 * Envoie, même si l'agent travaille encore : le message rejoint sa file d'entrée
 * et il refait son plan avec. C'est le comportement de Claude Code, et c'est ce
 * qui permet de le réorienter en pleine recherche.
 */
function submit(forced) {
  const text = (forced ?? input.value).trim()
  if (!text) return
  pushUserMessage(text, busy)
  api.send(text)
  input.value = ''
  autoGrow()
  setBusy(true)
  majBouton()
}

/** Le bouton envoie tant qu'il y a du texte ; il n'arrête l'agent que sur un champ vide. */
function majBouton() {
  document.body.classList.toggle('peut-envoyer', !!input.value.trim())
}

function autoGrow() {
  input.style.height = 'auto'
  input.style.height = `${Math.min(input.scrollHeight, 168)}px`
}

input.addEventListener('input', () => {
  autoGrow()
  majBouton()
  sendBtn.disabled = busy ? false : !input.value.trim()
})

input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit() }
})

document.addEventListener('keydown', (e) => {
  const pending = permsEnAttente[0]
  if (pending) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !input.value.trim()) {
      e.preventDefault(); e.stopPropagation(); pending.allow(); return
    }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); pending.deny(); return }
    return
  }
  if (e.key === 'Escape' && busy) { e.preventDefault(); api.interrupt() }
}, true)

sendBtn.addEventListener('click', () => {
  if (input.value.trim()) submit()
  else if (busy) api.interrupt()
})

document.getElementById('btn-new').addEventListener('click', nouvelleConversation)

document.getElementById('btn-settings').addEventListener('click', () => panneauReglages.classList.toggle('hidden'))
document.getElementById('btn-biblio').addEventListener('click', async () => {
  const montrer = document.body.classList.contains('docs-cachee')
  docsVisible(montrer)
  if (montrer) {
    documents = await api.docs.list(porteeDocs)
    renderDocuments()
  }
})
document.getElementById('btn-ouvrir-dossier').addEventListener('click', () => api.openBibliotheque())
document.getElementById('btn-ouvrir-biblio').addEventListener('click', () => api.openBibliotheque())
document.getElementById('btn-choisir').addEventListener('click', async () => {
  const res = await api.choisirBibliotheque()
  bibliotheque = res.bibliotheque
  documents = res.documents
  cheminBiblio.textContent = bibliotheque
  renderDocuments()
  statusBibliotheque()
})

modelSelect.addEventListener('change', () => api.setConfig({ model: modelSelect.value }))
profondeurSelect.addEventListener('change', () => api.setConfig({ profondeur: profondeurSelect.value }))
langueSelect.addEventListener('change', () => api.setConfig({ langue: langueSelect.value }))
autonomieSelect.addEventListener('change', () => api.setConfig({ autonomie: autonomieSelect.value }))

document.addEventListener('click', (e) => {
  const lien = e.target.closest('a[data-ext]')
  if (!lien) return
  e.preventDefault()
  api.openExternal(lien.getAttribute('href'))
})

// ------------------------------------------------------------- bibliothèque

function renderDocuments() {
  listeDocs.replaceChildren()
  if (!documents.length) {
    listeDocs.appendChild(el('div', 'vide', porteeDocs === 'tous'
      ? 'La bibliothèque est vide. Demande-moi un sujet.'
      : 'Aucun document dans cette conversation. Demande-moi un sujet : il apparaîtra ici, avec ses versions.'))
    return
  }
  for (const d of documents) listeDocs.appendChild(ficheDocument(d))
}

// ------------------------------------------------------- fils enregistrés

/**
 * Repeint un fil à partir de ce que l'application avait enregistré. On ne rejoue
 * ni la réflexion ni les demandes de validation : ce sont des instants, pas des
 * traces. Le reste — ce que Nicolas a demandé, ce qui a été lu, ce qui a été
 * écrit — se retrouve exactement à sa place.
 */
function restaurer(evenements) {
  permsEnAttente.length = 0
  enFile = []
  toolEls = new Map()
  currentText = null
  currentThinking = null
  currentSources = null
  thread.replaceChildren()

  if (!evenements?.length) {
    showWelcome()
    return
  }

  let groupeSources = null
  for (const e of evenements) {
    if (e.k !== 'source') groupeSources = null
    switch (e.k) {
      case 'user':
        thread.appendChild(el('div', 'msg user', e.texte))
        break
      case 'texte': {
        const n = el('div', 'msg assistant md')
        n.innerHTML = renderMarkdown(e.texte)
        thread.appendChild(n)
        break
      }
      case 'outil':
        thread.appendChild(noeudOutil(e.nom, e.arg, ''))
        break
      case 'source':
        if (!groupeSources) {
          groupeSources = el('div', 'sources-lues')
          thread.appendChild(groupeSources)
        }
        groupeSources.appendChild(puceSource({ id: e.id, titre: e.titre, url: e.url }))
        break
      case 'document':
        thread.appendChild(carteDocument({
          nom: e.nom, titre: e.titre, mots: e.mots || 0, sources_citees: e.sources || 0,
          version: e.version, remplace: e.remplace,
        }))
        break
      case 'note':
        thread.appendChild(el('div', `note${e.kind ? ` ${e.kind}` : ''}`, e.texte))
        break
    }
  }
  scrollDown(true)
}

// -------------------------------------------------------- barre latérale

function barreVisible(v) {
  document.body.classList.toggle('barre-cachee', !v)
  api.setConfig({ barreVisible: v })
}

function montrerBarre() {
  if (document.body.classList.contains('barre-cachee')) barreVisible(true)
}

function renderConversations() {
  listeConv.replaceChildren()
  if (!conversations.length) {
    listeConv.appendChild(el('div', 'vide', recherche.value.trim()
      ? 'Rien qui corresponde.'
      : 'Tes conversations s\'empileront ici, une par sujet.'))
    return
  }
  for (const c of conversations) {
    const ligne = el('div', `conv${c.id === convCourante ? ' active' : ''}${c.sansTitre ? ' sans-titre' : ''}`)
    const infos = el('div', 'infos')
    const titre = el('div', 't', c.titre)
    const meta = el('div', 'm')
    meta.appendChild(el('span', null, dateCourte(c.maj_le)))
    if (c.documents) meta.appendChild(el('span', 'docs-n', `${c.documents} doc${c.documents > 1 ? 's' : ''}`))
    const badge = ETATS[c.statut]
    if (badge) meta.appendChild(el('span', `etat ${badge.cls}`, badge.texte))
    infos.append(titre, meta)

    infos.addEventListener('click', () => {
      if (titre.isContentEditable || c.id === convCourante) return
      ouvrirConversation(c.id)
    })
    // Renommer sur place : le titre automatique n'est pas toujours le bon.
    titre.addEventListener('dblclick', () => {
      titre.contentEditable = 'plaintext-only'
      titre.focus()
      document.getSelection()?.selectAllChildren(titre)
    })
    const finEdition = async (garder) => {
      if (!titre.isContentEditable) return
      const valeur = titre.textContent.trim()
      titre.contentEditable = 'false'
      if (garder && valeur && valeur !== c.titre) {
        conversations = await api.conv.rename(c.id, valeur)
      }
      renderConversations()
    }
    titre.addEventListener('blur', () => finEdition(true))
    titre.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); finEdition(true) }
      if (e.key === 'Escape') { e.preventDefault(); finEdition(false) }
      e.stopPropagation()
    })

    ligne.appendChild(infos)
    if (c.statut === 'interrompu' || c.statut === 'incomplet') {
      const rep = el('button', 'rep', '↻')
      rep.title = 'Reprendre cette analyse'
      rep.addEventListener('click', async (e) => {
        e.stopPropagation()
        setBusy(true)
        await api.conv.resume(c.id)
      })
      ligne.appendChild(rep)
    }
    const sup = el('button', 'sup', '×')
    sup.title = 'Supprimer cette conversation'
    sup.addEventListener('click', async (e) => {
      e.stopPropagation()
      conversations = await api.conv.remove(c.id)
      renderConversations()
    })
    ligne.appendChild(sup)
    listeConv.appendChild(ligne)
  }
}

/** Ce qu'on veut voir d'un coup d'œil : ce qui tourne, et ce qui est resté en plan. */
const ETATS = {
  en_cours: { texte: 'en cours', cls: 'vif' },
  en_attente: { texte: 'en attente', cls: 'calme' },
  interrompu: { texte: 'interrompue', cls: 'tiede' },
  incomplet: { texte: 'inachevée', cls: 'tiede' },
}

function dateCourte(iso) {
  const d = new Date(iso)
  if (Number.isNaN(+d)) return ''
  const jours = Math.floor((Date.now() - d) / 86400000)
  if (jours <= 0) return d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
  if (jours === 1) return 'hier'
  if (jours < 7) return `il y a ${jours} j`
  return d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })
}

async function ouvrirConversation(id) {
  convCourante = await api.conv.open(id)
  input.focus()
}

async function nouvelleConversation() {
  montrerBarre()
  recherche.value = ''
  convCourante = await api.conv.create()
  input.focus()
}

let minuteurRecherche = null
recherche.addEventListener('input', () => {
  clearTimeout(minuteurRecherche)
  minuteurRecherche = setTimeout(async () => {
    conversations = await api.conv.list(recherche.value)
    renderConversations()
  }, 130)
})
recherche.addEventListener('keydown', (e) => {
  e.stopPropagation()
  if (e.key === 'Escape') {
    recherche.value = ''
    recherche.dispatchEvent(new Event('input'))
  }
})

document.getElementById('btn-new-barre').addEventListener('click', nouvelleConversation)
document.getElementById('btn-barre').addEventListener('click', () => {
  barreVisible(document.body.classList.contains('barre-cachee'))
})

// -------------------------------------------------------------- événements

api.onEvent((evt) => {
  switch (evt.k) {
    case 'ready':
      if (evt.outils === 'connected') statusBibliotheque()
      else setStatus(`Outils de rédaction : ${evt.outils}`, 'err')
      break
    case 'documents':
      documents = evt.documents
      if (evt.portee) porteeDocs = evt.portee
      if (typeof evt.total === 'number') totalDocs = evt.total
      renderDocuments()
      statusBibliotheque()
      break
    case 'status':
      if (evt.state === 'connecting') setStatus('Connexion…', 'pending')
      else {
        setBusy(evt.state === 'thinking')
        if (evt.state === 'idle') statusBibliotheque()
      }
      break
    case 'turn-start': setBusy(true); break
    case 'queued': setBusy(true); break
    case 'text-start': startTextBlock(); break
    case 'text-delta': appendText(evt.text); break
    case 'thinking-start': startThinking(); break
    case 'thinking-delta': appendThinking(evt.text); break
    case 'tool-use': addTool(evt); break
    case 'tool-result': endTool(evt); break
    case 'source': addSource(evt); break
    case 'document': addDocument(evt); break
    case 'permission': addPermission(evt); break
    case 'result':
      finishText(); finishThinking()
      if (evt.isError && evt.text) {
        addNote(evt.text, 'err')
        if (evt.reprenable) proposerReprise()
      }
      setBusy(false)
      break
    case 'interrupted':
      finishText(); finishThinking()
      addNote('Interrompu.')
      proposerReprise()
      setBusy(false)
      break
    case 'note': addNote(evt.text); break
    case 'reprise-possible': proposerReprise(); break
    case 'resumed': addNote('Reprise de la conversation précédente.'); break
    case 'conversation':
      convCourante = evt.id
      restaurer(evt.evenements)
      // Un fil qui travaillait pendant qu'on regardait ailleurs travaille toujours.
      setBusy(evt.statut === 'en_cours')
      if (evt.statut === 'en_attente') {
        addNote(`En attente d'une place : ${'deux conversations travaillent déjà'}. Elle partira toute seule.`)
      }
      // Un fil laissé en plan se signale à l'ouverture, pas seulement dans la liste.
      if (evt.evenements?.length && (evt.statut === 'interrompu' || evt.statut === 'incomplet')) {
        proposerReprise('↻ Reprendre cette analyse')
      }
      break
    case 'conversations':
      conversations = evt.liste
      if (evt.courante) convCourante = evt.courante
      renderConversations()
      break
    case 'basculer-barre':
      barreVisible(document.body.classList.contains('barre-cachee'))
      break
    case 'basculer-docs':
      docsVisible(document.body.classList.contains('docs-cachee'))
      break
    case 'error':
      finishText(); finishThinking()
      addNote(evt.message, 'err')
      setBusy(false)
      break
  }
})

// ---------------------------------------------------------------- démarrage

const state = await api.init()
modelSelect.value = state.config.model
profondeurSelect.value = state.config.profondeur || 'standard'
langueSelect.value = state.config.langue || 'français'
autonomieSelect.value = state.config.autonomie || 'auto'
bibliotheque = state.bibliotheque
cheminBiblio.textContent = bibliotheque
documents = state.documents || []
totalDocs = state.totalDocuments || 0
conversations = state.conversations || []
document.body.classList.toggle('barre-cachee', state.config.barreVisible === false)
document.body.classList.toggle('docs-cachee', state.config.docsVisible === false)
appliquerLargeur(barre, state.config.largeurBarre)
appliquerLargeur(docsBarre, state.config.largeurDocs)
porteeDocs = state.config.porteeDocs || 'conversation'
document.getElementById('portee-tous').classList.toggle('actif', porteeDocs === 'tous')
document.getElementById('portee-conv').classList.toggle('actif', porteeDocs !== 'tous')
renderDocuments()
renderConversations()
statusBibliotheque()
showWelcome()
setBusy(false)
input.focus()
