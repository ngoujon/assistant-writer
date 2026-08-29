// Le carrousel des sessions : deux fils qui travaillent, les autres qui attendent,
// et une navigation qui n'interrompt jamais rien.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const bac = fs.mkdtempSync(path.join(os.tmpdir(), 'redacteur-pool-'))
process.env.REDACTEUR_DATA_DIR = path.join(bac, 'donnees')
process.env.REDACTEUR_BIBLIOTHEQUE = path.join(bac, 'bibliotheque')

const { Pool } = await import('../src/agent/pool.mjs')

/** Une fausse session : on regarde ce qu'on lui envoie et si on l'arrête. */
function fausseSession(convId, journal) {
  return {
    running: false,
    start(o) { this.running = true; journal.push(`start:${convId}:${o?.resume || 'neuf'}`) },
    send(t) { journal.push(`send:${convId}:${t}`) },
    stop() { this.running = false; journal.push(`stop:${convId}`) },
    interrupt() { journal.push(`interrupt:${convId}`) },
    setModel() {},
  }
}

function pool({ reprises = {} } = {}) {
  const journal = []
  const sessions = new Map()
  const p = new Pool({
    creerSession: (id) => {
      const s = fausseSession(id, journal)
      sessions.set(id, s)
      return s
    },
    repriseDe: (id) => reprises[id],
    surEtat: () => {},
  })
  return { p, journal, sessions }
}

// 1. Deux fils partent tout de suite ; le troisième attend son tour.
{
  const { p, journal } = pool()
  assert.equal(p.envoyer('a', 'demande A'), 'envoye')
  assert.equal(p.envoyer('b', 'demande B'), 'envoye')
  assert.equal(p.envoyer('c', 'demande C'), 'attente')
  assert.equal(p.occupes(), 2)
  assert.deepEqual([p.etat('a'), p.etat('b'), p.etat('c')], ['travaille', 'travaille', 'attend'])
  assert.ok(journal.includes('send:a:demande A') && journal.includes('send:b:demande B'))
  assert.ok(!journal.some((l) => l.startsWith('send:c')), 'le troisième ne part pas avant son tour')

  // Une place se libère : le fil en attente part, avec ce qu'on lui avait écrit.
  p.finDeTour('a')
  assert.equal(p.etat('c'), 'travaille')
  assert.ok(journal.includes('send:c:demande C'))
  assert.equal(p.occupes(), 2, 'toujours deux, jamais trois')
}

// 2. On peut continuer à écrire à un fil qui attend : tout part d'un bloc.
{
  const { p, journal } = pool()
  p.envoyer('a', 'A')
  p.envoyer('b', 'B')
  p.envoyer('c', 'C1')
  p.envoyer('c', 'C2')
  assert.equal(p.etat('c'), 'attend')
  p.finDeTour('b')
  assert.ok(journal.includes('send:c:C1\n\nC2'), 'les messages en attente arrivent groupés')
}

// 3. Écrire à un fil qui travaille déjà : le message rejoint sa file d'entrée.
{
  const { p, journal } = pool()
  p.envoyer('a', 'A1')
  assert.equal(p.envoyer('a', 'A2'), 'envoye')
  assert.deepEqual(journal.filter((l) => l.startsWith('send:a')), ['send:a:A1', 'send:a:A2'])
}

// 4. LE POINT QUI COMPTE : naviguer n'interrompt pas ce qui travaille.
{
  const { p, journal } = pool()
  p.afficher('a')
  p.envoyer('a', 'longue recherche')
  p.envoyer('b', 'autre recherche')
  p.afficher('b')
  p.afficher('c')
  p.afficher('a')
  assert.equal(p.etat('a'), 'travaille', 'le fil regardé puis quitté travaille toujours')
  assert.equal(p.etat('b'), 'travaille')
  assert.equal(journal.filter((l) => l.startsWith('stop:')).length, 0, 'aucune session arrêtée')
}

// 5. Un fil qu'on quitte et qui ne fait rien rend son processus.
{
  const { p, journal } = pool()
  p.afficher('a')
  p.envoyer('a', 'A')
  p.finDeTour('a')
  assert.equal(journal.filter((l) => l === 'stop:a').length, 0, 'le fil regardé garde sa session au chaud')
  p.afficher('b')
  assert.ok(journal.includes('stop:a'), 'une fois quitté et inactif, il la rend')
}

// 6. Un tour fini sur un fil qu'on ne regarde pas libère tout de suite.
{
  const { p, journal } = pool()
  p.afficher('z')
  p.envoyer('a', 'A')
  p.finDeTour('a')
  assert.ok(journal.includes('stop:a'))
  assert.equal(p.etat('a'), 'libre')
}

// 7. Reprendre un fil repart de son contexte enregistré.
{
  const { p, journal } = pool({ reprises: { a: 'sess-123' } })
  p.envoyer('a', 'suite')
  assert.ok(journal.includes('start:a:sess-123'))
}

// 8. Supprimer un fil l'arrête et fait avancer la file.
{
  const { p, journal } = pool()
  p.envoyer('a', 'A')
  p.envoyer('b', 'B')
  p.envoyer('c', 'C')
  p.oublier('a')
  assert.ok(journal.includes('stop:a'))
  assert.equal(p.etat('c'), 'travaille', 'la place libérée profite à la file')
}

// 9. Interrompre ne touche que le fil visé.
{
  const { p, journal } = pool()
  p.envoyer('a', 'A')
  p.envoyer('b', 'B')
  p.interrompre('a')
  assert.deepEqual(journal.filter((l) => l.startsWith('interrupt:')), ['interrupt:a'])
}

fs.rmSync(bac, { recursive: true, force: true })
console.log('sessions parallèles : OK')
