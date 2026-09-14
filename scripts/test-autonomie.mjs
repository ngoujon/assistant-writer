// L'autonomie : ce que l'assistant peut faire sans rien demander, et ce qui
// change quand Nicolas remet le mode prudent.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const bac = fs.mkdtempSync(path.join(os.tmpdir(), 'redacteur-autonomie-'))
process.env.REDACTEUR_DATA_DIR = path.join(bac, 'donnees')
process.env.REDACTEUR_BIBLIOTHEQUE = path.join(bac, 'bibliotheque')

const { AgentSession } = await import('../src/agent/session.mjs')

/** Une session qu'on n'ouvre jamais : on n'inspecte que ses décisions. */
function session(autonomie) {
  const demandes = []
  const s = new AgentSession({
    emit: () => {},
    askPermission: async (req) => {
      demandes.push(req.toolName)
      return { behavior: 'deny', message: 'refusé pour le test' }
    },
    getConfig: () => ({ model: 'claude-opus-5', autonomie }),
  })
  return { s, demandes }
}

// 1. En autonomie, rien n'est demandé — pas même une commande shell.
{
  const { s, demandes } = session('auto')
  assert.equal(s.autonome(), true)
  for (const [outil, entree] of [
    ['Bash', { command: 'ls ~/Documents' }],
    ['Write', { file_path: '/tmp/note.md' }],
    ['Edit', { file_path: '/tmp/note.md' }],
  ]) {
    const r = await s.handlePermission(outil, entree, {})
    assert.equal(r.behavior, 'allow', `${outil} devrait passer seul`)
  }
  assert.deepEqual(demandes, [], 'aucune carte de validation ouverte')

  // Et une action d'outil qui demanderait normalement confirmation passe aussi.
  assert.equal(await s.confirmerAction({ outil: 'supprimer_document', titre: 'Supprimer ?' }), true)
  assert.deepEqual(demandes, [])
}

// 2. En mode prudent, les mêmes actions ouvrent une carte.
{
  const { s, demandes } = session('prudent')
  assert.equal(s.autonome(), false)
  const r = await s.handlePermission('Bash', { command: 'rm -rf /tmp/x' }, {})
  assert.equal(r.behavior, 'deny', 'la carte a été refusée, donc l\'action ne part pas')
  assert.deepEqual(demandes, ['Bash'])

  assert.equal(await s.confirmerAction({ outil: 'supprimer_document', titre: 'Supprimer ?' }), false)
  assert.deepEqual(demandes, ['Bash', 'supprimer_document'])
}

// 3. Dans les deux modes, lire ne demande jamais rien.
for (const mode of ['auto', 'prudent']) {
  const { s, demandes } = session(mode)
  for (const outil of ['Read', 'Glob', 'Grep', 'WebSearch', 'TodoWrite']) {
    assert.equal((await s.handlePermission(outil, {}, {})).behavior, 'allow')
  }
  // Les outils de rédaction décident eux-mêmes : la session ne les double pas.
  assert.equal((await s.handlePermission('mcp__redacteur__rediger_document', {}, {})).behavior, 'allow')
  assert.deepEqual(demandes, [], `mode ${mode} : la lecture ne se valide pas`)
}

// 4. Sans réglage, on est autonome : c'est le comportement voulu par défaut.
{
  const s = new AgentSession({ emit: () => {}, askPermission: async () => ({}), getConfig: () => ({}) })
  assert.equal(s.autonome(), true)
}

fs.rmSync(bac, { recursive: true, force: true })
console.log('autonomie : OK')
