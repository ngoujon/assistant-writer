// L'autonomie : ce que l'assistant peut faire sans rien demander, et ce qui
// change quand Nicolas remet le mode prudent.
//
// Depuis le passage au moteur local, la question ne se pose plus que pour les outils
// de rédaction : il n'y a plus de shell ni d'écriture libre sur le disque, donc plus
// rien d'autre à valider. Seule la suppression d'un document ouvre une carte.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const bac = fs.mkdtempSync(path.join(os.tmpdir(), 'redacteur-autonomie-'))
process.env.REDACTEUR_DATA_DIR = path.join(bac, 'donnees')
process.env.REDACTEUR_BIBLIOTHEQUE = path.join(bac, 'bibliotheque')

const { AgentSession } = await import('../src/agent/session.mjs')
const { ecrireDocument, listerDocuments } = await import('../src/doc/bibliotheque.mjs')

/** Une session qu'on n'ouvre jamais : on n'inspecte que ses décisions. */
function session(autonomie) {
  const demandes = []
  const s = new AgentSession({
    emit: () => {},
    askPermission: async (req) => {
      demandes.push(req.toolName)
      return { behavior: 'deny', message: 'refusé pour le test' }
    },
    getConfig: () => ({ model: 'qwen/qwen3.8-27b', autonomie }),
  })
  return { s, demandes }
}

// 1. En autonomie, rien n'est demandé — pas même une suppression.
{
  const { s, demandes } = session('auto')
  assert.equal(s.autonome(), true)
  assert.equal(await s.confirmerAction({ outil: 'supprimer_document', titre: 'Supprimer ?' }), true)
  assert.deepEqual(demandes, [], 'aucune carte de validation ouverte')
}

// 2. En mode prudent, la même action ouvre une carte — et un refus arrête tout.
{
  const { s, demandes } = session('prudent')
  assert.equal(s.autonome(), false)
  assert.equal(await s.confirmerAction({ outil: 'supprimer_document', titre: 'Supprimer ?' }), false)
  assert.deepEqual(demandes, ['supprimer_document'])
}

// 3. Dans les deux modes, chercher, lire et rédiger ne demandent jamais rien :
//    c'est exactement ce qu'on vient de demander à l'assistant.
for (const mode of ['auto', 'prudent']) {
  const { s, demandes } = session(mode)
  const boite = s.construireOutils()
  await boite.executer('lister_documents', {})
  await boite.executer('rediger_document', {
    titre: `Essai ${mode}`,
    markdown: 'Un document sans source, pour le test.',
    sans_source: true,
  })
  assert.deepEqual(demandes, [], `mode ${mode} : rédiger ne se valide pas`)
}
assert.equal(listerDocuments().length, 2)

// 4. En mode prudent, supprimer passe par la carte, et le refus laisse le fichier.
{
  const { s, demandes } = session('prudent')
  const boite = s.construireOutils()
  const nom = listerDocuments()[0].nom
  const res = await boite.executer('supprimer_document', { nom })
  assert.equal(res.refus, true)
  assert.deepEqual(demandes, ['supprimer_document'])
  assert.equal(listerDocuments().length, 2, 'rien n\'a été supprimé')
}

// 5. Sans réglage, on est autonome : c'est le comportement voulu par défaut.
{
  const s = new AgentSession({ emit: () => {}, askPermission: async () => ({}), getConfig: () => ({}) })
  assert.equal(s.autonome(), true)
}

fs.rmSync(bac, { recursive: true, force: true })
console.log('autonomie : OK')
