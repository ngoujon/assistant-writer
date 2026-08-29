// Prévisualisation de l'interface, sans agent : rejoue une conversation type,
// vérifie les raccourcis clavier, puis écrit une capture PNG. Usage :
//   npx electron scripts/apercu.mjs [sortie.png]
import { app, BrowserWindow, nativeTheme } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const out = process.argv[2] || path.join(root, 'apercu.png')

const src = (id, titre, url) => ({ k: 'source', source: { id, titre, url, editeur: 'ONS', consultee_le: '2026-08-29T09:00:00Z', type: 'html' }, deja_lue: false })

const SCENARIO = [
  { evt: { k: 'ready', sessionId: 'x', model: 'claude-opus-5', outils: 'connected' } },
  { user: 'Fais-moi un rapport complet sur la situation économique de Londres' },
  { evt: { k: 'tool-use', id: 't0', name: 'WebSearch', input: { query: 'London economy GDP 2026 ONS' } } },
  { evt: { k: 'tool-result', id: 't0', name: 'WebSearch', ok: true, preview: '9 résultats' } },
  { evt: src('s1', 'GDP, UK regions and countries', 'https://www.ons.gov.uk/economy/gdp') },
  { evt: src('s2', 'London Labour Market Update — August 2026', 'https://www.london.gov.uk/labour-market') },
  { evt: src('s3', 'City of London: financial services output', 'https://www.cityoflondon.gov.uk/research') },
  { evt: { k: 'text-start' } },
  { evt: { k: 'text-delta', text: "Trois sources primaires lues (ONS, GLA, City of London). Je complète avec l'immobilier de bureau et l'inflation, puis je rédige.\n\nPoint notable : **l'écart entre la City et le reste du Grand Londres se creuse** — je lui donnerai une section." } },
  { evt: { k: 'tool-use', id: 't1', name: 'mcp__redacteur__rediger_document', input: { titre: 'Situation économique de Londres — état des lieux, août 2026', sources: ['s1', 's2', 's3'] } } },
  { evt: { k: 'tool-result', id: 't1', name: 'mcp__redacteur__rediger_document', ok: true, preview: 'enregistré' } },
  {
    evt: {
      k: 'document',
      document: {
        nom: '2026-08-29-situation-economique-de-londres.md',
        titre: 'Situation économique de Londres — état des lieux, août 2026',
        mots: 2480, sources_citees: 9, version: 2, remplace: true,
      },
    },
  },
  { evt: { k: 'text-start' } },
  { evt: { k: 'text-delta', text: "**2 480 mots, 9 sources.** L'essentiel : croissance de 1,4 % au T2 2026, mais portée à 70 % par la finance et l'assurance ; le chômage remonte à 5,8 % dans les boroughs de l'est. Deux chiffres du GLA et de l'ONS se contredisent sur l'emploi — c'est signalé dans le document." } },
  { evt: { k: 'result', isError: false, costUsd: 0.21, durationMs: 94000 } },
]

// Filet : un aperçu qui se bloque doit échouer, pas attendre indéfiniment.
setTimeout(() => {
  console.log('APERÇU ÉCHEC — bloqué au-delà de 90 s')
  app.exit(1)
}, 90000).unref?.()

app.whenReady().then(async () => {
  if (process.env.THEME) nativeTheme.themeSource = process.env.THEME
  const win = new BrowserWindow({
    width: 980, height: 840, show: false,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 18 },
    backgroundColor: process.env.THEME === 'dark' ? '#16181e' : '#f8fafd',
    webPreferences: { preload: path.join(root, 'scripts', 'apercu-preload.cjs'), contextIsolation: true },
  })

  const erreurs = []
  win.webContents.on('console-message', (d) => {
    if (d.level === 'error' || d.level === 3) erreurs.push(d.message)
  })
  win.webContents.on('render-process-gone', (_e, d) => erreurs.push(`renderer perdu : ${d.reason}`))
  // Une erreur dans l'interface doit se voir tout de suite, pas à la fin.
  win.webContents.on('console-message', (d) => {
    if (d.level === 'error' || d.level === 3) console.log('CONSOLE:', String(d.message).slice(0, 300))
  })
  await win.loadFile(path.join(root, 'src', 'renderer', 'index.html'))

  const taper = (texte) => win.webContents.executeJavaScript(
    `(() => {
       const box = document.getElementById('input')
       box.value = ${JSON.stringify(texte)}
       box.dispatchEvent(new Event('input'))
       document.getElementById('btn-send').click()
     })()`,
  )
  const tirer = (evt) => win.webContents.executeJavaScript(`window.redacteur._fire(${JSON.stringify(evt)})`)

  for (const etape of SCENARIO) {
    if (etape.user) await taper(etape.user)
    else await tirer(etape.evt)
    await new Promise((r) => setTimeout(r, 60))
  }

  const carteDoc = await win.webContents.executeJavaScript(
    "!!document.querySelector('.doc-carte .vers-doc')",
  )
  // La carte du fil n'ouvre plus rien elle-même.
  const carteSansActions = await win.webContents.executeJavaScript(
    "!document.querySelector('.doc-carte .btns')",
  )
  const ficheOuvrir = await win.webContents.executeJavaScript(
    "[...document.querySelectorAll('.doc-fiche .actions-doc button')].some(b => b.textContent === 'Ouvrir')",
  )
  // L'historique s'ouvre depuis la colonne de droite, pas depuis la carte.
  await win.webContents.executeJavaScript(
    "document.querySelector('.doc-fiche .plier')?.click()",
  )
  await new Promise((r) => setTimeout(r, 320))
  const versionsListees = await win.webContents.executeJavaScript(
    "document.querySelectorAll('.doc-fiche .vlist .vligne').length",
  )
  const premiereVersion = await win.webContents.executeJavaScript(
    "document.querySelector('.doc-fiche .vlist .vligne .vn')?.textContent || ''",
  )
  const puces = await win.webContents.executeJavaScript("document.querySelectorAll('.puce-source').length")

  // Écrire pendant qu'il travaille doit rester possible.
  await tirer({ k: 'status', state: 'thinking' })
  await taper('ajoute une partie sur l\'immobilier de bureau')
  await new Promise((r) => setTimeout(r, 120))
  const envoyePendant = await win.webContents.executeJavaScript(
    "!!document.querySelector('.msg.user.enfile') && document.querySelectorAll('.msg.user').length",
  )
  await tirer({ k: 'text-start' })
  await tirer({ k: 'text-delta', text: "Je reprends le document avec une section « Immobilier de bureau »." })
  await new Promise((r) => setTimeout(r, 120))
  const marqueurRetire = await win.webContents.executeJavaScript("document.querySelectorAll('.msg.user.enfile').length === 0")

  // La seule carte de validation qui reste : la suppression. Retoucher un document
  // n'en demande plus, puisque chaque écriture publie une version de plus.
  await tirer({
    k: 'permission',
    id: 'p1',
    toolName: 'mcp__redacteur__supprimer_document',
    allowAlways: false,
    title: 'Supprimer « Situation économique de Londres » ?',
    hint: 'Le fichier et tout son historique sont effacés du disque.',
    summary: {
      danger: true,
      lines: ['2026-08-29-situation-economique-de-londres.md\n3 120 mots, 11 sources, 3 versions'],
    },
    input: { nom: '2026-08-29-situation-economique-de-londres.md' },
  })
  await new Promise((r) => setTimeout(r, 600))

  const rendus = await win.webContents.executeJavaScript("document.querySelectorAll('#thread > *').length")

  const image = await win.webContents.capturePage()
  fs.writeFileSync(out, image.toPNG())

  // Un tour qui s'arrête en route doit proposer la reprise, en français.
  await tirer({ k: 'result', isError: true, reprenable: true, text: "J'ai atteint la limite d'étapes pour ce message — le travail n'est pas terminé. Clique « Continuer » ou écris « continue » : je reprends où j'en étais." })
  await new Promise((r) => setTimeout(r, 200))
  const boutonReprise = await win.webContents.executeJavaScript(
    "document.querySelector('.reprise .chip')?.textContent || ''",
  )
  const noteAnglaise = await win.webContents.executeJavaScript(
    "[...document.querySelectorAll('.note')].some(n => /\\b(I'm|sorry|currently)\\b/.test(n.textContent))",
  )
  // Et la liste doit offrir la même reprise sur un fil resté en plan.
  const repriseListe = await win.webContents.executeJavaScript(
    "document.querySelectorAll('#liste-conv .conv .rep').length",
  )

  // La barre latérale : liste des conversations, et la recherche qui filtre.
  const convsListees = await win.webContents.executeJavaScript(
    "document.querySelectorAll('#liste-conv .conv').length",
  )
  const badgesEtat = await win.webContents.executeJavaScript(
    "[...document.querySelectorAll('#liste-conv .conv .etat')].map(e => e.textContent).join('/')",
  )
  const convActive = await win.webContents.executeJavaScript(
    "document.querySelectorAll('#liste-conv .conv.active').length",
  )
  await win.webContents.executeJavaScript(
    `(() => {
       const r = document.getElementById('recherche')
       r.value = 'bois'
       r.dispatchEvent(new Event('input'))
     })()`,
  )
  await new Promise((r) => setTimeout(r, 320))
  const convsFiltrees = await win.webContents.executeJavaScript(
    "document.querySelectorAll('#liste-conv .conv').length",
  )
  await win.webContents.executeJavaScript(
    `(() => {
       const r = document.getElementById('recherche')
       r.value = ''
       r.dispatchEvent(new Event('input'))
     })()`,
  )
  await new Promise((r) => setTimeout(r, 320))

  // Le bouton ☰ replie la barre.
  await win.webContents.executeJavaScript("document.getElementById('btn-barre').click()")
  await new Promise((r) => setTimeout(r, 260))
  const barreRepliee = await win.webContents.executeJavaScript("document.body.classList.contains('barre-cachee')")
  await win.webContents.executeJavaScript("document.getElementById('btn-barre').click()")
  await new Promise((r) => setTimeout(r, 260))

  // La colonne des documents est là dès l'ouverture.
  const docsListes = await win.webContents.executeJavaScript(
    "document.body.classList.contains('docs-cachee') ? 0 : document.querySelectorAll('#liste-docs .doc-fiche').length",
  )

  // Raccourci clavier : « esc » doit refuser la carte en attente.
  const avant = await win.webContents.executeJavaScript("document.querySelectorAll('.perm.answered').length")
  await win.webContents.executeJavaScript("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))")
  await new Promise((r) => setTimeout(r, 200))
  const apres = await win.webContents.executeJavaScript("document.querySelectorAll('.perm.answered').length")

  console.log('reprise proposée      :', boutonReprise || 'AUCUNE', '| dans la liste :', repriseListe)
  console.log('note en anglais       :', noteAnglaise ? 'OUI (problème)' : 'non')
  console.log('versions (colonne)   :', versionsListees, '| la plus récente en tête :', premiereVersion)
  console.log('carte sans actions   :', carteSansActions, '| fiche « Ouvrir » :', ficheOuvrir)
  console.log('états des fils        :', badgesEtat || 'aucun')
  console.log('conversations listées:', convsListees, '| active :', convActive, '| filtrées « bois » :', convsFiltrees)
  console.log('barre repliable      :', barreRepliee)
  console.log('puces de sources     :', puces)
  console.log('carte du document    :', carteDoc, '(renvoi vers la colonne)')
  console.log('envoi pendant travail:', envoyePendant ? `ok, ${envoyePendant} messages` : 'BLOQUÉ')
  console.log('marqueur retiré      :', marqueurRetire)
  console.log('blocs rendus         :', rendus)
  console.log('documents listés     :', docsListes)
  console.log('esc sur la carte     :', `${avant} -> ${apres} répondue(s)`)
  console.log('erreurs console      :', erreurs.length ? erreurs.join(' | ') : 'aucune')
  console.log('capture              :', out)

  const ok = rendus > 6 && puces === 3 && carteDoc && envoyePendant === 2 && marqueurRetire
    && docsListes === 2 && apres === 1 && !erreurs.length
    && convsListees === 3 && convActive === 0 && convsFiltrees === 1 && barreRepliee
    && versionsListees === 3 && premiereVersion === 'v3' && carteSansActions && ficheOuvrir
    && badgesEtat === 'en cours/inachevée/en attente'
    && /Reprendre/.test(boutonReprise) && !noteAnglaise && repriseListe === 1
  console.log(ok ? 'APERÇU OK' : 'APERÇU ÉCHEC')
  app.exit(ok ? 0 : 1)
})

process.on('unhandledRejection', (err) => {
  console.log('APERÇU ÉCHEC — le scénario a levé :', String(err?.message || err).slice(0, 300))
  app.exit(1)
})
