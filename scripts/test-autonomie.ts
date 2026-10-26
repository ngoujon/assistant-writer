// L'autonomie : ce que l'assistant peut faire sans rien demander, et ce qui
// change quand Nicolas remet le mode prudent.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ConfigAgent } from '../src/agent/session.ts'

const bac = fs.mkdtempSync(path.join(os.tmpdir(), 'redacteur-autonomie-'))
process.env.REDACTEUR_DATA_DIR = path.join(bac, 'donnees')
process.env.REDACTEUR_BIBLIOTHEQUE = path.join(bac, 'bibliotheque')

const { AgentSession } = await import('../src/agent/session.ts')

/** Une session qu'on n'ouvre jamais : on n'inspecte que ses décisions. */
/** Les options du SDK ne servent pas ici : la décision ne dépend que de l'outil. */
const OPTS = {} as Parameters<InstanceType<typeof AgentSession>['handlePermission']>[2]

function session(autonomie: string) {
  const demandes: string[] = []
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
  const actions: Array<[string, Record<string, unknown>]> = [
    ['Bash', { command: 'ls ~/Documents' }],
    ['Write', { file_path: '/tmp/note.md' }],
    ['Edit', { file_path: '/tmp/note.md' }],
  ]
  for (const [outil, entree] of actions) {
    const r = await s.handlePermission(outil, entree, OPTS)
    assert.equal(r.behavior, 'allow', `${outil} devrait passer seul`)
  }
  assert.deepEqual(demandes, [], 'aucune carte de validation ouverte')

  // Et une action d'outil qui demanderait normalement confirmation passe aussi.
  assert.equal(await s.confirmerAction({ outil: 'supprimer_document', titre: 'Supprimer ?', entree: {}, lignes: [] }), true)
  assert.deepEqual(demandes, [])
}

// 2. En mode prudent, les mêmes actions ouvrent une carte.
{
  const { s, demandes } = session('prudent')
  assert.equal(s.autonome(), false)
  const r = await s.handlePermission('Bash', { command: 'rm -rf /tmp/x' }, OPTS)
  assert.equal(r.behavior, 'deny', 'la carte a été refusée, donc l\'action ne part pas')
  assert.deepEqual(demandes, ['Bash'])

  assert.equal(await s.confirmerAction({ outil: 'supprimer_document', titre: 'Supprimer ?', entree: {}, lignes: [] }), false)
  assert.deepEqual(demandes, ['Bash', 'supprimer_document'])
}

// 3. Dans les deux modes, lire ne demande jamais rien.
for (const mode of ['auto', 'prudent']) {
  const { s, demandes } = session(mode)
  for (const outil of ['Read', 'Glob', 'Grep', 'WebSearch', 'TodoWrite']) {
    assert.equal((await s.handlePermission(outil, {}, OPTS)).behavior, 'allow')
  }
  // Les outils de rédaction décident eux-mêmes : la session ne les double pas.
  assert.equal((await s.handlePermission('mcp__redacteur__rediger_document', {}, OPTS)).behavior, 'allow')
  assert.deepEqual(demandes, [], `mode ${mode} : la lecture ne se valide pas`)
}

// 4. Sans réglage, on est autonome : c'est le comportement voulu par défaut.
{
  const s = new AgentSession({ emit: () => {}, askPermission: async () => null, getConfig: () => ({}) as ConfigAgent })
  assert.equal(s.autonome(), true)
}

fs.rmSync(bac, { recursive: true, force: true })
console.log('autonomie : OK')
