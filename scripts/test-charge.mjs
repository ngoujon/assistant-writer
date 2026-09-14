// Test de charge : une vraie demande lourde, menée jusqu'au bout, hors Electron.
//
// C'est le test qui compte pour l'usage réel : est-ce qu'une recherche large
// produit un document, ou est-ce qu'elle s'arrête en route sans rien laisser ?
// Usage : node scripts/test-charge.mjs ["ma demande"] [minutes]
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const DEMANDE = process.argv[2]
  || "J'ai besoin d'une synthèse du vocabulaire et des notions à connaître sur les grands modèles de langage : "
   + 'contexte, quantification, hallucination, RAG, agents. Sourcé.'
const MINUTES = Number(process.argv[3] || 12)

const bac = fs.mkdtempSync(path.join(os.tmpdir(), 'redacteur-charge-'))
process.env.REDACTEUR_DATA_DIR = path.join(bac, 'donnees')
process.env.REDACTEUR_BIBLIOTHEQUE = path.join(bac, 'bibliotheque')

const { AgentSession } = await import('../src/agent/session.mjs')
const { listerDocuments, versionsDocument } = await import('../src/doc/bibliotheque.mjs')
const { registre } = await import('../src/doc/sources.mjs')

const t0 = Date.now()
const min = () => `${((Date.now() - t0) / 60000).toFixed(1)} min`
const vu = { fini: false, erreurs: [], notes: [], versions: [], titre: null, anglais: [] }
let texte = ''

const session = new AgentSession({
  emit: (e) => {
    switch (e.k) {
      case 'ready': console.log(`[${min()}] PRÊT — ${e.model}, outils ${e.outils}`); break
      case 'titre': vu.titre = e.titre; console.log(`[${min()}] TITRE  « ${e.titre} »`); break
      case 'source': console.log(`[${min()}] SOURCE ${e.source.id} ${String(e.source.titre).slice(0, 60)}`); break
      case 'document':
        vu.versions.push(e.document)
        console.log(`[${min()}] DOC    v${e.document.version} — ${e.document.mots} mots, ${e.document.sources_citees} sources`)
        break
      case 'text-delta': texte += e.text; break
      case 'note': vu.notes.push(e.text); console.log(`[${min()}] NOTE   ${e.text.slice(0, 120)}`); break
      case 'error': vu.erreurs.push(e.message); console.log(`[${min()}] ERREUR ${e.message.slice(0, 200)}`); break
      case 'result':
        if (e.isError) { vu.erreurs.push(e.text); console.log(`[${min()}] ARRÊT  ${String(e.text).slice(0, 200)}`) }
        else console.log(`[${min()}] TOUR TERMINÉ — ${(e.costUsd || 0).toFixed(3)} $`)
        vu.fini = true
        break
    }
  },
  askPermission: async (req) => {
    console.log(`[${min()}] VALID. refusée pour ${req.toolName}`)
    return { behavior: 'deny', message: 'test automatique' }
  },
  getConfig: () => ({ model: 'claude-opus-5', profondeur: 'standard', langue: 'français' }),
  ouvrirFichier: () => {},
})

console.log(`Demande : ${DEMANDE}\nPlafond : ${MINUTES} min\n`)
session.start({})
session.send(DEMANDE)

// On relance une fois si le tour s'arrête sans document : c'est exactement le
// comportement du bouton « Reprendre » de la fenêtre.
let relances = 0
const limite = Date.now() + MINUTES * 60000
while (Date.now() < limite) {
  await new Promise((r) => setTimeout(r, 500))
  if (!vu.fini) continue
  if (vu.versions.length && !vu.erreurs.length) break
  if (relances >= 2) break
  relances += 1
  vu.fini = false
  console.log(`[${min()}] ↻ RELANCE ${relances} (comme le bouton « Reprendre »)`)
  session.send("Reprends exactement où tu t'étais arrêté. Si tu as de quoi écrire, publie d'abord une version du document.")
}
session.stop()

const docs = listerDocuments()
const motsAnglais = /\b(I'm|I have|sorry|currently|reading|sources so far|let me|I'll)\b/i
if (motsAnglais.test(texte)) vu.anglais.push(texte.match(motsAnglais)[0])

console.log('\n================ BILAN ================')
console.log('durée            :', min())
console.log('titre du fil     :', vu.titre || '— aucun (titrer_conversation non appelé)')
console.log('sources lues     :', registre().length)
console.log('versions publiées:', vu.versions.map((v) => `v${v.version} (${v.mots} mots)`).join(', ') || 'AUCUNE')
console.log('documents        :', docs.map((d) => `${d.nom} — ${d.mots} mots, ${d.sources} src, v${d.version}`).join('\n                   ') || 'AUCUN')
if (docs[0]) console.log('historique       :', versionsDocument(docs[0].nom).map((v) => `v${v.numero}`).join(', '))
console.log('relances         :', relances)
console.log('erreurs          :', vu.erreurs.length ? vu.erreurs.join(' | ').slice(0, 300) : 'aucune')
console.log('anglais détecté  :', vu.anglais.length ? vu.anglais.join(', ') : 'non')

const ok = docs.length >= 1 && docs[0].mots > 500 && docs[0].sources >= 3 && !vu.anglais.length
console.log('\ndossier de test  :', bac)
console.log(ok ? 'TEST DE CHARGE OK' : 'TEST DE CHARGE ÉCHEC')
if (ok) fs.rmSync(bac, { recursive: true, force: true })
process.exit(ok ? 0 : 1)
