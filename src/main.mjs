import { app, BrowserWindow, ipcMain, shell, dialog, Menu, nativeTheme, screen } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { setDataRoot, setBibliotheque, bibliothequeParDefaut, P } from './doc/paths.mjs'
import { AgentSession } from './agent/session.mjs'
import { Pool, MAX_EN_PARALLELE } from './agent/pool.mjs'
import { PROMPT_VERSION } from './agent/prompt.mjs'
import {
  listerDocuments, lireDocument, supprimerDocument, versionsDocument, lireVersion, LISEZ_MOI,
} from './doc/bibliotheque.mjs'
import { registre } from './doc/sources.mjs'
import * as Conv from './doc/conversations.mjs'
import { tracer, cheminJournal } from './doc/journal.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const CONFIG_DEFAUT = {
  model: 'claude-opus-5',
  // Longueur et nombre de sources visés. Voir agent/prompt.mjs.
  profondeur: 'standard',
  langue: 'français',
  // « auto » : l'assistant mène son travail seul, sans rien faire valider.
  // « prudent » : une carte s'ouvre avant ce qui sort de la bibliothèque et
  // avant un effacement.
  autonomie: 'auto',
  // Ouvrir le document dans l'app Markdown dès qu'il est écrit. Éteint : les
  // documents s'ouvrent depuis le panneau de droite, quand on le décide.
  ouvrirAuto: false,
  bibliotheque: null,
  barreVisible: true,
  docsVisible: true,
  // Largeur des colonnes latérales, en pixels. null = un tiers de la fenêtre.
  largeurBarre: null,
  largeurDocs: null,
  // « conversation » : seuls les documents du fil ouvert. « tous » : la bibliothèque.
  porteeDocs: 'conversation',
  bounds: null,
  conversation: null,
  promptVersion: 0,
  // Migrations de largeur, une par étape de mise en page.
  elargieBarre: false,
  elargieDocs: false,
  largeurTiers: false,
}

let config = { ...CONFIG_DEFAUT }
let configPath = ''
let win = null
let pool = null
let quitting = false

/** La conversation regardée dans la fenêtre. Les autres continuent sans elle. */
let courante = null
/** Les règles ont changé : on n'essaie pas de reprendre les fils d'avant. */
let resumeInterdit = false

const permissionsEnAttente = new Map()
let seqPermission = 0

// ------------------------------------------------------------------ config

function loadConfig() {
  configPath = path.join(app.getPath('userData'), 'reglages.json')
  try {
    config = { ...CONFIG_DEFAUT, ...JSON.parse(fs.readFileSync(configPath, 'utf8')) }
  } catch {
    config = { ...CONFIG_DEFAUT }
  }
  const voulue = boundsParDefaut()
  // Une fois, on ramène la fenêtre à la largeur voulue : les migrations
  // précédentes l'avaient élargie au-delà du tiers d'écran.
  if (!config.largeurTiers) {
    config.bounds = { ...(config.bounds || {}), width: voulue.width, height: config.bounds?.height || voulue.height }
  }
  config.elargieBarre = true
  config.elargieDocs = true
  config.largeurTiers = true
  // Des dimensions enregistrées incomplètes donneraient une fenêtre minuscule.
  if (config.bounds && !(config.bounds.width > 0 && config.bounds.height > 0)) {
    config.bounds = {
      ...config.bounds,
      width: config.bounds.width > 0 ? config.bounds.width : voulue.width,
      height: config.bounds.height > 0 ? config.bounds.height : voulue.height,
    }
  }
  saveConfig()
}

/**
 * Un tiers de l'écran, en largeur. La fenêtre se partage ensuite en trois
 * colonnes égales : conversations, fil, documents. Plancher à 480 px pour un
 * petit écran, où les colonnes latérales se replient de toute façon.
 */
function boundsParDefaut() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize
  return {
    width: Math.max(480, Math.round(width / 3)),
    height: Math.round(height * 0.92),
  }
}

let saveTimer = null
function saveConfig() {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(configPath), { recursive: true })
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2))
    } catch {}
  }, 300)
}

function ensureBibliotheque() {
  setBibliotheque(config.bibliotheque || bibliothequeParDefaut())
  const lisezMoi = path.join(P.bibliotheque(), LISEZ_MOI)
  if (!fs.existsSync(lisezMoi) && !listerDocuments().length) {
    fs.writeFileSync(lisezMoi, [
      '# Ta bibliothèque',
      '',
      "Les documents écrits par l'Assistant Rédacteur atterrissent ici, en Markdown,",
      'un fichier par sujet. Ce sont des fichiers ordinaires : ouvre-les, déplace-les,',
      'sauvegarde-les avec le reste de tes documents.',
      '',
      'Chacun porte un en-tête (titre, sujet, dates, nombre de sources) et se termine par',
      'la liste des pages réellement consultées, avec leur date de consultation.',
      '',
    ].join('\n'))
  }
}

// ----------------------------------------------------------------- fenêtre

function createWindow() {
  const { width, height, x, y } = config.bounds || boundsParDefaut()
  win = new BrowserWindow({
    width, height, x, y,
    minWidth: 420,
    minHeight: 520,
    show: false,
    title: 'Assistant Rédacteur',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 18 },
    vibrancy: 'sidebar',
    visualEffectState: 'active',
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  })

  win.webContents.on('did-start-loading', () => { rendererPret = false })
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'))
  win.once('ready-to-show', () => win.show())

  win.on('close', (e) => {
    if (!quitting) { e.preventDefault(); win.hide() }
  })
  const memoriser = () => {
    if (!win || win.isDestroyed() || win.isMinimized()) return
    config.bounds = win.getBounds()
    saveConfig()
  }
  win.on('resize', memoriser)
  win.on('move', memoriser)

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
}

// Le renderer n'écoute qu'après son chargement : on met les événements de
// démarrage en attente pour ne pas perdre l'état de connexion.
let rendererPret = false
const enAttente = []

function emit(evt) {
  if (!rendererPret) {
    enAttente.push(evt)
    if (enAttente.length > 200) enAttente.shift()
    return
  }
  if (win && !win.isDestroyed()) win.webContents.send('agent', evt)
}

function viderAttente() {
  rendererPret = true
  for (const evt of enAttente.splice(0, enAttente.length)) {
    if (win && !win.isDestroyed()) win.webContents.send('agent', evt)
  }
}

// ------------------------------------------------------- mémoire des fils
//
// Ce que la fenêtre a affiché est réenregistré au fil de l'eau : le SDK sait
// reprendre le contexte du modèle, pas ce qu'on avait sous les yeux.

/** Le texte en cours de frappe du modèle, par fil : plusieurs écrivent à la fois. */
const tampons = new Map()

function viderTampon(convId) {
  const t = (tampons.get(convId) || '').trim()
  tampons.delete(convId)
  if (t) majListe(Conv.ajouter(convId, { k: 'texte', texte: t }))
}

/**
 * Les documents à montrer : ceux du fil ouvert, ou toute la bibliothèque.
 *
 * Un document appartient à la conversation qui l'a écrit. Voir ceux des autres
 * fils en travaillant sur un sujet n'aide personne — d'où le tri par défaut.
 */
function documentsAffiches(portee = config.porteeDocs, convId = courante?.id) {
  const tous = listerDocuments()
  if (portee === 'tous' || !convId) return tous
  const siens = new Set(Conv.fil(convId)?.documents || [])
  return tous.filter((d) => siens.has(d.nom))
}

function diffuserDocuments() {
  emit({
    k: 'documents',
    documents: documentsAffiches(),
    portee: config.porteeDocs,
    total: listerDocuments().length,
  })
}

/** La liste des fils, chacun portant son état réel : en cours, en attente, en plan. */
const ETAT_VISIBLE = { travaille: 'en_cours', attend: 'en_attente' }

function listeConversations(recherche) {
  const etats = pool ? pool.etats() : new Map()
  return Conv.lister(recherche).map((c) => {
    const vif = ETAT_VISIBLE[etats.get(c.id)]
    return vif ? { ...c, statut: vif } : c
  })
}

function majListe(resume) {
  if (!resume) return
  if (resume.id === courante?.id) courante = { ...courante, ...resume }
  diffuserListe()
}

function diffuserListe() {
  emit({ k: 'conversations', liste: listeConversations(), courante: courante?.id || null })
}

function noterUtilisateur(convId, texte) {
  viderTampon(convId)
  majListe(Conv.ajouter(convId, { k: 'user', texte }))
}

/** Un argument d'outil lisible en une ligne, pour rejouer le fil plus tard. */
function argOutil(input) {
  if (!input || typeof input !== 'object') return ''
  for (const k of ['url', 'query', 'titre', 'nom', 'command', 'id', 'pattern', 'file_path']) {
    if (typeof input[k] === 'string' && input[k]) return input[k].slice(0, 200)
  }
  return ''
}

function noterEvenement(convId, evt) {
  switch (evt.k) {
    case 'text-start':
      viderTampon(convId)
      break
    case 'text-delta':
      tampons.set(convId, (tampons.get(convId) || '') + evt.text)
      break
    case 'tool-use':
      viderTampon(convId)
      majListe(Conv.ajouter(convId, { k: 'outil', nom: evt.name, arg: argOutil(evt.input) }))
      break
    case 'source':
      viderTampon(convId)
      majListe(Conv.ajouter(convId, {
        k: 'source', id: evt.source.id, titre: evt.source.titre, url: evt.source.url,
      }))
      break
    case 'document':
      viderTampon(convId)
      majListe(Conv.ajouter(convId, {
        k: 'document',
        nom: evt.document.nom,
        titre: evt.document.titre,
        mots: evt.document.mots,
        sources: evt.document.sources_citees,
        version: evt.document.version,
        remplace: evt.document.remplace,
      }))
      break
    case 'result':
      viderTampon(convId)
      majListe(Conv.marquerStatut(convId, evt.isError ? 'incomplet' : 'termine'))
      break
    case 'interrupted':
      viderTampon(convId)
      majListe(Conv.marquerStatut(convId, 'interrompu'))
      break
    case 'error':
      viderTampon(convId)
      Conv.marquerStatut(convId, 'incomplet')
      majListe(Conv.ajouter(convId, { k: 'note', texte: evt.message, kind: 'err' }))
      break
  }
}

/**
 * Un événement arrive d'un fil — pas forcément celui qu'on regarde. Il est
 * toujours enregistré dans SON fil ; il n'est affiché que s'il vient du fil
 * ouvert. C'est ce qui permet à deux recherches de tourner sans se mélanger.
 */
function routerEvenement(convId, evt) {
  if (evt.k === 'ready' || evt.k === 'error') tracer('agent', convId, evt.k, evt)

  if (evt.k === 'ready' && evt.sessionId) Conv.memoriserSession(convId, evt.sessionId)
  // Le modèle a nommé le fil : on ne recouvre pas un titre posé à la main.
  if (evt.k === 'titre') majListe(Conv.renommer(convId, evt.titre, { manuel: false }))
  noterEvenement(convId, evt)

  // Le document est rattaché à son fil : la colonne de droite ne bouge que si
  // c'est ce fil qu'on regarde — ou si on a demandé à voir toute la bibliothèque.
  if (evt.k === 'document' && (convId === courante?.id || config.porteeDocs === 'tous')) {
    diffuserDocuments()
  }

  // Le tour est fini : la place se libère et la file avance.
  if (evt.k === 'result' || evt.k === 'interrupted') pool.finDeTour(convId)

  if (convId === courante?.id) emit(evt)
  else if (evt.k === 'document' || evt.k === 'result') diffuserListe()
}

// --------------------------------------------------------------- permission

function askPermission(req) {
  return new Promise((resolve) => {
    const id = `perm-${++seqPermission}`
    permissionsEnAttente.set(id, resolve)
    const onAbort = () => {
      if (permissionsEnAttente.delete(id)) resolve({ behavior: 'deny', message: 'Annulé.' })
    }
    req.signal?.addEventListener('abort', onAbort, { once: true })

    emit({
      k: 'permission',
      id,
      origine: req.convId && req.convId !== courante?.id
        ? (Conv.fil(req.convId)?.titre || 'une autre conversation')
        : null,
      toolName: req.toolName,
      title: req.title,
      displayName: req.displayName,
      subtitle: req.subtitle,
      reason: req.reason,
      summary: req.summary,
      hint: req.hint,
      allowAlways: req.allowAlways !== false,
      input: req.input,
    })
    if (win && !win.isVisible()) win.show()
  })
}

function resolvePermission(id, reponse) {
  const resolve = permissionsEnAttente.get(id)
  if (!resolve) return
  permissionsEnAttente.delete(id)
  resolve(reponse)
}

function refuserToutes(message) {
  for (const [id, resolve] of permissionsEnAttente) {
    permissionsEnAttente.delete(id)
    resolve({ behavior: 'deny', message })
  }
}

// ------------------------------------------------------------ conversations

/**
 * Ouvre un fil : on change ce qu'on regarde, rien d'autre.
 *
 * Ce qui travaille dans les autres fils continue de travailler — c'est tout
 * l'intérêt d'avoir plusieurs sessions. Naviguer ne coûte rien et n'annule rien.
 */
function ouvrirConversation(id, { neuve = false } = {}) {
  if (!neuve && id && id === courante?.id) {
    peindreConversation()
    return courante
  }

  if (courante) viderTampon(courante.id)
  if (id) viderTampon(id)

  const conv = (id && Conv.fil(id)) || null
  courante = conv || Conv.creer()
  config.conversation = courante.id
  saveConfig()

  pool.afficher(courante.id)
  peindreConversation(conv?.evenements || [])
  return courante
}

/** L'identifiant de session à reprendre pour ce fil, s'il en a un d'exploitable. */
function repriseDe(convId) {
  if (resumeInterdit) return undefined
  return Conv.fil(convId)?.sessionId || undefined
}

function peindreConversation(evenements) {
  diffuserDocuments()
  emit({
    k: 'conversation',
    id: courante.id,
    titre: courante.titre || null,
    statut: ETAT_VISIBLE[pool?.etat(courante.id)] || courante.statut || null,
    evenements: evenements || Conv.fil(courante.id)?.evenements || [],
  })
  diffuserListe()
}

/**
 * Reprend un fil laissé en plan : on rebranche la session sur son contexte et on
 * demande la suite. C'est la sortie de secours quand un tour s'arrête tout seul.
 */
function reprendreConversation(id) {
  const cible = id || courante?.id
  if (!cible) return null
  const consigne = "Reprends exactement où tu t'étais arrêté, sans refaire ce qui est déjà fait. "
    + "Si tu as déjà de quoi écrire quelque chose d'utile, publie d'abord une version du document, "
    + "puis continue à l'enrichir."
  return demander(cible, consigne)
}

/**
 * Achemine une demande vers son fil. Si deux fils travaillent déjà, elle attend
 * son tour — et on le dit, plutôt que de laisser croire qu'il ne se passe rien.
 */
function demander(convId, texte) {
  noterUtilisateur(convId, texte)
  const sort = pool.envoyer(convId, texte)
  if (sort === 'attente') {
    const note = `En attente : ${MAX_EN_PARALLELE} conversations travaillent déjà. `
      + 'Celle-ci partira dès qu\'une place se libère — tu peux continuer à lui écrire en attendant.'
    majListe(Conv.ajouter(convId, { k: 'note', texte: note }))
    if (convId === courante?.id) emit({ k: 'note', text: note })
  }
  diffuserListe()
  return convId
}

// ---------------------------------------------------------------------- IPC

function ouvrirFichier(chemin) {
  if (chemin && fs.existsSync(chemin)) shell.openPath(chemin)
}

function wireIpc() {
  ipcMain.handle('app:init', () => {
    setImmediate(viderAttente)
    return {
      config: {
        model: config.model,
        profondeur: config.profondeur,
        langue: config.langue,
        autonomie: config.autonomie || 'auto',
        ouvrirAuto: config.ouvrirAuto,
        barreVisible: config.barreVisible !== false,
        docsVisible: config.docsVisible !== false,
        largeurBarre: config.largeurBarre,
        largeurDocs: config.largeurDocs,
        porteeDocs: config.porteeDocs || 'conversation',
      },
      bibliotheque: P.bibliotheque(),
      documents: documentsAffiches(),
      totalDocuments: listerDocuments().length,
      conversations: listeConversations(),
      version: app.getVersion(),
    }
  })

  ipcMain.on('chat:send', (_e, text) => {
    if (!text?.trim() || !courante) return
    demander(courante.id, text.trim())
  })
  ipcMain.on('chat:interrupt', () => { if (courante) pool.interrompre(courante.id) })
  ipcMain.on('chat:config', (_e, patch) => {
    Object.assign(config, patch)
    saveConfig()
    if (patch.model) pool.setModel(patch.model)
    // Profondeur et langue vivent dans le prompt système : les sessions repartent.
    if (patch.profondeur || patch.langue || patch.autonomie) {
      emit({ k: 'note', text: 'Nouvelles règles de rédaction : la suite repart sur un contexte neuf.' })
      pool.toutArreter()
      diffuserListe()
    }
  })
  ipcMain.on('perm:reply', (_e, { id, answer }) => resolvePermission(id, answer))

  ipcMain.handle('conv:list', (_e, recherche) => listeConversations(recherche))
  ipcMain.handle('conv:new', () => ouvrirConversation(null, { neuve: true }).id)
  ipcMain.handle('conv:open', (_e, id) => ouvrirConversation(id).id)
  ipcMain.handle('conv:resume', (_e, id) => reprendreConversation(id))
  ipcMain.handle('conv:rename', (_e, { id, titre }) => {
    const r = Conv.renommer(id, titre)
    if (r && courante?.id === id) courante = { ...courante, ...r }
    return listeConversations()
  })
  ipcMain.handle('conv:delete', (_e, id) => {
    pool.oublier(id)
    Conv.supprimer(id)
    if (courante?.id === id) {
      const suivante = Conv.lister()[0]
      ouvrirConversation(suivante?.id || null, { neuve: !suivante })
    }
    return listeConversations()
  })

  ipcMain.handle('docs:list', (_e, portee) => documentsAffiches(portee))
  ipcMain.handle('docs:versions', (_e, nom) => {
    try { return versionsDocument(nom) } catch { return [] }
  })
  ipcMain.on('docs:open-version', (_e, { nom, numero }) => {
    try { ouvrirFichier(lireVersion(nom, numero).chemin) } catch {}
  })

  // Exporter, c'est sortir une copie de la bibliothèque : l'original ne bouge pas.
  ipcMain.handle('docs:export', async (_e, { nom, numero } = {}) => {
    try {
      const doc = lireDocument(nom)
      const source = numero ? lireVersion(nom, numero).chemin : doc.chemin
      const base = doc.nom.replace(/\.md$/, '')
      const { canceled, filePath } = await dialog.showSaveDialog(win, {
        title: 'Exporter le document',
        defaultPath: path.join(app.getPath('downloads'), numero ? `${base}-v${numero}.md` : `${base}.md`),
        filters: [{ name: 'Markdown', extensions: ['md'] }],
      })
      if (canceled || !filePath) return { annule: true }
      fs.copyFileSync(source, filePath)
      shell.showItemInFolder(filePath)
      return { chemin: filePath }
    } catch (err) {
      return { erreur: String(err?.message || err) }
    }
  })
  ipcMain.handle('docs:sources', () => registre())
  ipcMain.on('docs:open', (_e, nom) => {
    try { ouvrirFichier(lireDocument(nom).chemin) } catch {}
  })
  ipcMain.on('docs:reveal', (_e, nom) => {
    try { shell.showItemInFolder(lireDocument(nom).chemin) } catch {}
  })
  ipcMain.handle('docs:delete', async (_e, nom) => {
    try {
      const doc = lireDocument(nom)
      const { response } = await dialog.showMessageBox(win, {
        type: 'warning',
        buttons: ['Supprimer', 'Annuler'],
        defaultId: 1,
        cancelId: 1,
        message: `Supprimer « ${doc.titre} » ?`,
        detail: `${doc.nom} — ${doc.mots} mots. Le fichier part à la corbeille.`,
      })
      if (response !== 0) return documentsAffiches()
      await shell.trashItem(doc.chemin).catch(() => supprimerDocument(nom))
    } catch {}
    const docs = documentsAffiches()
    diffuserDocuments()
    return docs
  })

  ipcMain.handle('app:choisir-bibliotheque', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: 'Où ranger les documents ?',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: P.bibliotheque(),
    })
    if (canceled || !filePaths?.[0]) return { bibliotheque: P.bibliotheque(), documents: listerDocuments() }
    config.bibliotheque = filePaths[0]
    saveConfig()
    setBibliotheque(filePaths[0])
    emit({ k: 'note', text: 'Bibliothèque déplacée : la suite repart sur un contexte neuf.' })
    pool.toutArreter()
    diffuserListe()
    return { bibliotheque: P.bibliotheque(), documents: listerDocuments() }
  })

  ipcMain.on('app:open-bibliotheque', () => shell.openPath(P.bibliotheque()))
  ipcMain.on('app:open-external', (_e, url) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url)
  })
}

function buildMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: 'Assistant Rédacteur',
      submenu: [
        { role: 'about', label: "À propos de l'Assistant Rédacteur" },
        { type: 'separator' },
        { role: 'hide', label: 'Masquer' },
        { role: 'hideOthers', label: 'Masquer les autres' },
        { type: 'separator' },
        { role: 'quit', label: 'Quitter' },
      ],
    },
    {
      label: 'Conversation',
      submenu: [
        {
          label: 'Nouvelle conversation',
          accelerator: 'CmdOrCtrl+N',
          click: () => ouvrirConversation(null, { neuve: true }),
        },
        {
          label: 'Afficher la liste des conversations',
          accelerator: 'CmdOrCtrl+L',
          click: () => emit({ k: 'basculer-barre' }),
        },
        {
          label: 'Afficher les documents',
          accelerator: 'CmdOrCtrl+D',
          click: () => emit({ k: 'basculer-docs' }),
        },
        {
          label: 'Largeur optimale (un tiers de l\'écran)',
          accelerator: 'CmdOrCtrl+0',
          click: () => {
            if (!win || win.isDestroyed()) return
            const { width, height } = boundsParDefaut()
            win.setBounds({ ...win.getBounds(), width, height })
          },
        },
        // Pas d'accélérateur « Esc » : la touche est traitée dans l'interface, où
        // elle refuse d'abord une demande de validation en attente.
        { label: 'Interrompre', accelerator: 'CmdOrCtrl+.', click: () => { if (courante) pool.interrompre(courante.id) } },
        { type: 'separator' },
        { label: 'Ouvrir la bibliothèque', accelerator: 'CmdOrCtrl+Shift+O', click: () => shell.openPath(P.bibliotheque()) },
        { label: 'Ouvrir le journal de bord', click: () => shell.openPath(cheminJournal()) },
      ],
    },
    { role: 'editMenu', label: 'Édition' },
    {
      label: 'Fenêtre',
      submenu: [
        { role: 'minimize', label: 'Réduire' },
        { role: 'close', label: 'Fermer' },
        { type: 'separator' },
        { role: 'toggleDevTools', label: 'Outils de développement' },
      ],
    },
  ]))
}

// -------------------------------------------------------------- cycle de vie

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => { if (win) { win.show(); win.focus() } })

  app.whenReady().then(() => {
    nativeTheme.themeSource = 'system'
    setDataRoot(app.getPath('userData'))
    loadConfig()
    tracer('--- démarrage', app.getVersion(), '| données', app.getPath('userData'))
    createWindow()
    buildMenu()
    wireIpc()

    pool = new Pool({
      creerSession: (convId) => new AgentSession({
        emit: (evt) => routerEvenement(convId, evt),
        askPermission: (req) => askPermission({ ...req, convId }),
        getConfig: () => config,
        ouvrirFichier,
        envoyerCorbeille: async (chemin) => {
          try { await shell.trashItem(chemin); return true } catch { return false }
        },
      }),
      repriseDe,
      surEtat: () => diffuserListe(),
    })

    process.on('unhandledRejection', (err) => {
      emit({ k: 'error', message: `Agent indisponible : ${String(err?.message || err)}` })
      emit({ k: 'status', state: 'idle' })
    })

    // La bibliothèque et l'agent démarrent une fois la fenêtre à l'écran : lire un
    // dossier peut demander une autorisation à macOS, qui fige le processus le
    // temps de la réponse — sans fenêtre, l'app paraîtrait plantée.
    win.once('ready-to-show', () => {
      tracer('fenêtre affichée')
      try {
        ensureBibliotheque()
        diffuserDocuments()
      } catch {}

      resumeInterdit = config.promptVersion !== PROMPT_VERSION
      if (resumeInterdit) {
        config.promptVersion = PROMPT_VERSION
        saveConfig()
      }
      ouvrirConversation(config.conversation)
      tracer('conversation ouverte', courante?.id, '| bibliothèque', P.bibliotheque())
    })

    app.on('activate', () => {
      if (win) { win.show(); win.focus() } else createWindow()
    })
  })

  app.on('before-quit', () => {
    quitting = true
    refuserToutes("Fermeture de l'application.")
    for (const id of [...tampons.keys()]) viderTampon(id)
    pool?.toutArreter()
  })

  app.on('window-all-closed', () => { /* l'app reste dans le Dock */ })
}
