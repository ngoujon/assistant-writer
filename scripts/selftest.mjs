// Test d'intégration hors Electron : démarre une vraie session contre le serveur
// local, vérifie qu'une page est réellement consultée et qu'un document sort de la
// bibliothèque. Écrit dans un dossier temporaire.
//
// Il lui faut donc le serveur allumé (LM Studio) et un accès web. Adresse par défaut :
// celle des réglages ; sinon `REDACTEUR_SERVEUR=http://…:1234/v1 npm run selftest`.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const bac = fs.mkdtempSync(path.join(os.tmpdir(), 'redacteur-selftest-'))
process.env.REDACTEUR_DATA_DIR = path.join(bac, 'donnees')
process.env.REDACTEUR_BIBLIOTHEQUE = path.join(bac, 'bibliotheque')

const { AgentSession } = await import('../src/agent/session.mjs')
const { listerModeles, SERVEUR_DEFAUT, racine } = await import('../src/agent/moteur.mjs')
const { listerDocuments } = await import('../src/doc/bibliotheque.mjs')
const { registre } = await import('../src/doc/sources.mjs')

const SERVEUR = process.env.REDACTEUR_SERVEUR || SERVEUR_DEFAUT
let MODELE = process.env.REDACTEUR_MODELE || ''
try {
  const dispo = await listerModeles(SERVEUR)
  if (!MODELE) MODELE = (dispo.find((m) => m.charge && m.outils) || dispo.find((m) => m.outils) || dispo[0])?.id
  console.log('SERVEUR', racine(SERVEUR), '| modèles :', dispo.map((m) => m.id).join(', ') || 'aucun')
} catch (err) {
  console.log('SERVEUR', racine(SERVEUR), '— injoignable :', String(err?.message || err))
  process.exit(1)
}
if (!MODELE) { console.log('Aucun modèle de discussion sur ce serveur.'); process.exit(1) }
console.log('MODÈLE ', MODELE)

const vu = { ready: null, texte: '', outils: [], sources: [], documents: [], perms: [], fini: false }

const session = new AgentSession({
  emit: (e) => {
    if (e.k === 'ready') { vu.ready = e; console.log('PRÊT    outils =', e.outils, '| modèle =', e.model) }
    if (e.k === 'text-delta') vu.texte += e.text
    if (e.k === 'tool-use') { vu.outils.push(e.name); console.log('OUTIL  ', e.name) }
    if (e.k === 'tool-result' && !e.ok) console.log('ERREUR OUTIL', e.name, e.preview?.slice(0, 200))
    if (e.k === 'source') { vu.sources.push(e.source); console.log('SOURCE ', e.source.id, e.source.titre) }
    if (e.k === 'document') { vu.documents.push(e.document); console.log('DOC    ', e.document.nom, e.document.mots, 'mots') }
    if (e.k === 'error') console.log('ERREUR ', e.message)
    if (e.k === 'result') vu.fini = true
  },
  askPermission: async (req) => {
    vu.perms.push(req.toolName)
    console.log('VALID. demandée pour', req.toolName, '->', req.title || '')
    return { behavior: 'deny', message: 'test automatique' }
  },
  getConfig: () => ({ serveur: SERVEUR, model: MODELE, profondeur: 'bref', langue: 'français', autonomie: 'auto' }),
  ouvrirFichier: () => {},
})

session.start({})
session.send(
  'Consulte https://example.com et rédige un tout petit document (5 lignes suffisent) qui décrit ce que contient ' +
  'cette page. Ne cherche rien d\'autre sur le web.',
)

const debut = Date.now()
while (!vu.fini && Date.now() - debut < 240000) await new Promise((r) => setTimeout(r, 300))
session.stop()

const docs = listerDocuments()
console.log('\n--- réponse ---\n' + vu.texte.trim().slice(0, 600))
console.log('\noutils appelés  :', vu.outils.join(', ') || 'aucun')
console.log('sources lues    :', registre().map((s) => `${s.id} ${s.url}`).join(', ') || 'aucune')
console.log('documents écrits:', docs.map((d) => `${d.nom} (${d.mots} mots, ${d.sources} src)`).join(', ') || 'aucun')

const ok = vu.ready?.outils === 'connected'
  && vu.sources.length >= 1
  && docs.length === 1
  && docs[0].sources >= 1
  && /example\.com/.test(fs.readFileSync(path.join(process.env.REDACTEUR_BIBLIOTHEQUE, docs[0].nom), 'utf8'))

console.log('\ndossier de test :', bac)
console.log(ok ? 'SELFTEST OK' : 'SELFTEST ÉCHEC')
if (ok) fs.rmSync(bac, { recursive: true, force: true })
process.exit(ok ? 0 : 1)
