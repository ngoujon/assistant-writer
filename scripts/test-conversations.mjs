// Les fils : titre qui se fabrique tout seul, recherche dans le contenu, et un
// affichage qui se retrouve intact après un aller-retour.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const bac = fs.mkdtempSync(path.join(os.tmpdir(), 'redacteur-conv-'))
process.env.REDACTEUR_DATA_DIR = path.join(bac, 'donnees')
process.env.REDACTEUR_BIBLIOTHEQUE = path.join(bac, 'bibliotheque')

const C = await import('../src/doc/conversations.mjs')

// 1. Une conversation neuve n'a pas de titre : elle en prend un à la première demande.
const a = C.creer()
assert.equal(a.titre, null)
assert.equal(C.lister()[0].sansTitre, true)

C.ajouter(a.id, { k: 'user', texte: 'Fais-moi un rapport complet sur la situation économique de Londres' })
assert.equal(C.lister()[0].titre, 'Fais-moi un rapport complet sur la situation économique de…')
assert.equal(C.lister()[0].sansTitre, false)

// 2. Le titre du document prend le dessus : c'est ce qu'on cherchera plus tard.
C.ajouter(a.id, { k: 'source', id: 's1', titre: 'GDP, UK regions', url: 'https://ons.gov.uk/pib' })
C.ajouter(a.id, { k: 'texte', texte: 'Trois sources primaires lues.' })
C.ajouter(a.id, { k: 'document', nom: '2026-08-29-londres.md', titre: 'Situation économique de Londres', mots: 2480, sources: 9 })
assert.equal(C.lister()[0].titre, 'Situation économique de Londres')
assert.equal(C.lister()[0].documents, 1)
assert.equal(C.lister()[0].messages, 1)

// 3. Un deuxième fil, et la recherche qui doit les départager.
const b = C.creer()
C.ajouter(b.id, { k: 'user', texte: 'Le marché du bois construction en France' })
assert.equal(C.lister().length, 2)
assert.equal(C.lister()[0].id, b.id, 'le plus récemment touché passe en tête')
assert.equal(C.lister('londres').length, 1)
assert.equal(C.lister('bois').length, 1)
assert.equal(C.lister('tokyo').length, 0)
// La recherche descend dans le contenu, pas seulement dans les titres.
assert.equal(C.lister('ons.gov.uk')[0].id, a.id, 'on retrouve un fil par une source lue')
assert.equal(C.lister('sources primaires')[0].id, a.id, 'et par ce qui a été répondu')

// 3 bis. Le résumé compte les documents ; documentsDe les nomme. Confondre les
//        deux faisait planter l'ouverture d'un fil.
assert.equal(C.lister().find((x) => x.id === a.id).documents, 1, 'le résumé donne un nombre')
assert.deepEqual(C.documentsDe(a.id), ['2026-08-29-londres.md'], 'documentsDe donne la liste')
assert.equal(typeof C.fil(a.id).documents, 'number', 'le fil porte le même compte que le résumé')
assert.deepEqual(C.documentsDe('cinconnu'), [], 'un fil inconnu ne rend pas null')
assert.doesNotThrow(() => new Set(C.documentsDe(a.id)))

// 4. Le fil se rejoue à l'identique.
const fil = C.fil(a.id)
assert.equal(fil.evenements.length, 4)
assert.deepEqual(fil.evenements.map((e) => e.k), ['user', 'source', 'texte', 'document'])
assert.equal(fil.evenements[3].mots, 2480)

// 5. Renommer à la main tient.
C.renommer(a.id, 'Londres — dossier éco')
assert.equal(C.lister('londres —')[0].titre, 'Londres — dossier éco')

// 6. L'identifiant de session est mémorisé pour la reprise.
C.memoriserSession(a.id, 'sess-42')
assert.equal(C.fil(a.id).sessionId, 'sess-42')

// 7. Supprimer.
C.supprimer(b.id)
assert.equal(C.lister().length, 1)
assert.equal(C.fil(b.id), null)

// 8. Un identifiant fabriqué ne sort pas du dossier des conversations.
assert.equal(C.lire('../../reglages'), null)

fs.rmSync(bac, { recursive: true, force: true })
console.log('conversations : OK')
